import type { Pool, PoolClient } from 'pg';
import type { WebhookConfig, WebhookStore, WebhookEventType } from '../../services/webhooks/types.js';

/**
 * Repository error that carries a machine-readable code so callers can
 * distinguish not-found / conflict / transient failures without parsing messages.
 */
export class WebhookRepositoryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT' | 'DATABASE',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WebhookRepositoryError';
  }
}

/**
 * The columns that must be present on a webhook_configs row for mapToConfig
 * to produce a valid WebhookConfig. This is used to fail fast and explicitly
 * when the underlying schema is missing columns, instead of silently returning
 * configs with undefined fields.
 */
const REQUIRED_CONFIG_COLUMNS = ['id', 'url', 'secret', 'secret_updated_at', 'active', 'events'] as const;

function isTransientPgError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  // 40001 invalid_schema_name, 40003 invalid_schema_name, 57P01 operator_intervention,
  // 08006 connection_exception, 08003 connection_does_not_exist, 08006 connection_failure,
  // 53300 too_many_connections, 40001 serialization_failure.
  return (
    code === '40001' ||
    code === '40003' ||
    code === '57P01' ||
    code === '08006' ||
    code === '08003' ||
    code === '53300'
  );
}

export class PostgresWebhookRepository implements WebhookStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Atomically reserve an idempotency key for a subscriber/event pair.
   *
   * Returns true when this call created the reservation (i.e. the caller owns
   * the delivery attempt) and false when a reservation already existed.
   * The unique constraint is (subscriber_id, event_id), so concurrent callers
   * racing on the same pair will exactly one win.
   */
  async reserveWebhookDelivery(subscriberId: string, eventId: string, idempotencyKey: string): Promise<boolean> {
    if (!subscriberId || !eventId || !idempotencyKey) {
      throw new WebhookRepositoryError('INVALID_INPUT', 'reserveWebhookDelivery requires non-empty subscriberId, eventId and idempotencyKey');
    }

    try {
      const { rowCount } = await this.pool.query(
        `INSERT INTO webhook_delivery_keys (subscriber_id, event_id, idempotency_key, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (subscriber_id, event_id) DO NOTHING`,
        [subscriberId, eventId, idempotencyKey],
      );

      return (rowCount ?? 0) > 0;
    } catch (err) {
      throw new WebhookRepositoryError(
        'DATABASE',
        isTransientPgError(err)
          ? 'transient database error reserving webhook delivery'
          : 'failed to reserve webhook delivery',
        err,
      );
    }
  }

  /**
   * Release a previously reserved delivery attempt so it can be retried.
   * Idempotent: deleting a non-existent reservation is a no-op.
   */
  async clearWebhookDeliveryAttempt(subscriberId: string, eventId: string): Promise<void> {
    if (!subscriberId || !eventId) {
      throw new WebhookRepositoryError('INVALID_INPUT', 'clearWebhookDeliveryAttempt requires non-empty subscriberId and eventId');
    }

    try {
      await this.pool.query(
        'DELETE FROM webhook_delivery_keys WHERE subscriber_id = $1 AND event_id = $2',
        [subscriberId, eventId],
      );
    } catch (err) {
      throw new WebhookRepositoryError('DATABASE', 'failed to clear webhook delivery attempt', err);
    }
  }

  async getByEvent(event: WebhookEventType): Promise<WebhookConfig[]> {
    if (!event) {
      throw new WebhookRepositoryError('INVALID_INPUT', 'getByEvent requires a non-empty event');
    }

    try {
      const { rows } = await this.pool.query(
        'SELECT * FROM webhook_configs WHERE active = true AND $1 = ANYN(events)',
        [event],
      );
      return rows.map((row) => this.mapToConfig(row));
    } catch (err) {
      throw new WebhookRepositoryError('DATABASE', 'failed to load webhook configs by event', err);
    }
  }

  async get(id: string): Promise<WebhookConfig | null> {
    if (!id) {
      throw new WebhookRepositoryError('INVALID_INPUT', 'get requires a non-empty id');
    }

    try {
      const { rows } = await this.pool.query('SELECT * FROM webhook_configs WHERE id = $1', [id]);
      if (rows.length === 0) return null;
      return this.mapToConfig(rows[0]);
    } catch (err) {
      throw new WebhookRepositoryError('DATABASE', 'failed to load webhook config', err);
    }
  }

  async set(config: WebhookConfig): Promise<void> {
    if (!config || !config.id || !config.url || !config.secret) {
      throw new WebhookRepositoryError('INVALID_INPUT', 'set requires a config with id, url and secret');
    }

    try {
      await this.pool.query(
        `INSERT INTO webhook_configs (id, url, secret, previous_secret, secret_updated_at, active, events, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (id) DO UPDATE SET
           url = EXCLUDED.url,
           secret = EXCLUDED.secret,
           previous_secret = EXCLUDED.previous_secret,
           secret_updated_at = EXCLUDED.secret_updated_at,
           active = EXCLUDED.active,
           events = EXCLUDED.events,
           updated_at = NOW()`,
        [
          config.id,
          config.url,
          config.secret,
          config.previousSecret || null,
          config.secretUpdatedAt,
          config.active,
          config.events,
        ],
      );
    } catch (err) {
      throw new WebhookRepositoryError('DATABASE', 'failed to persist webhook config', err);
    }
  }

  /**
   * Rotate the signing secret for an existing webhook.
   *
   * The update is a single atomic statement, so concurrent rotations cannot
   * interleave. If the row does not exist, a typed NOT_FOUND error is thrown.
   */
  async rotateSecret(
    id: string,
    newSecret: string,
    previousSecret: string,
    previousSecretExpiresAt: string,
  ): Promise<WebhookConfig> {
    if (!id || !newSecret || !previousSecret || !previousSecretExpiresAt) {
      throw new WebhookRepositoryError(
        'INVALID_INPUT',
        'rotateSecret requires id, newSecret, previousSecret and previousSecretExpiresAt',
      );
    }

    try {
      const { rows } = await this.pool.query(
        `UPDATE webhook_configs
         SET secret = $2,
             previous_secret = $3,
             previous_secret_expires_at = $4,
             secret_updated_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, newSecret, previousSecret, previousSecretExpiresAt],
      );

      if (rows.length === 0) {
        throw new WebhookRepositoryError('NOT_FOUND', `Webhook not found: ${id}`);
      }

      return this.mapToConfig(rows[0]);
    } catch (err) {
      if (err instanceof WebhookRepositoryError) throw err;
      throw new WebhookRepositoryError('DATABASE', 'failed to rotate webhook secret', err);
    }
  }

  /**
   * Map a raw webhook_configs row to a WebhookConfig.
   *
   * This fails loud when required columns are missing or have invalid types,
   * rather than silently producing a config with undefined fields that would
   * break downstream delivery logic.
   */
  private mapToConfig(row: any): WebhookConfig {
    if (!row || typeof row !== 'object') {
      throw new WebhookRepositoryError('DATABASE', 'encountered an invalid webhook_configs row');
    }

    for (const column of REQUIRED_CONFIG_COLUMNS) {
      if (row[column] === undefined || row[column] === null) {
        throw new WebhookRepositoryError(
          'DATABASE',
          `webhook_configs row is missing required column '${column}'`,
        );
      }
    }

    const secretUpdatedAt = new Date(row.secret_updated_at);
    if (Number.isNaN(secretUpdatedAt.getTime())) {
      throw new WebhookRepositoryError(
        'DATABASE',
        'webhook_configs row has an invalid secret_updated_at timestamp',
      );
    }

    if (!Array.isArray(row.events)) {
      throw new WebhookRepositoryError('DATABASE', 'webhook_configs row has non-array events');
    }

    return {
      id: row.id,
      url: row.url,
      secret: row.secret,
      previousSecret: row.previous_secret || undefined,
      previousSecretExpiresAt: row.previous_secret_expires_at || undefined,
      secretUpdatedAt,
      active: row.active,
      events: row.events as WebhookEventType[],
      maxAttempts: row.max_attempts ?? undefined,
      timeoutMs: row.timeout_ms ?? undefined,
    };
  }
}
