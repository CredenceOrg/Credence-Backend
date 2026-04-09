import type { Pool } from 'pg';
import type { WebhookConfig, WebhookStore, WebhookEventType } from '../../services/webhooks/types.js';

export class PostgresWebhookRepository implements WebhookStore {
  constructor(private readonly pool: Pool) {}

  async getByEvent(event: WebhookEventType): Promise<WebhookConfig[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM webhook_configs WHERE active = true AND $1 = ANY(events)',
      [event]
    );
    return rows.map(this.mapToConfig);
  }

  async get(id: string): Promise<WebhookConfig | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM webhook_configs WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return null;
    return this.mapToConfig(rows[0]);
  }

  async set(config: WebhookConfig): Promise<void> {
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
      ]
    );
  }

  private mapToConfig(row: any): WebhookConfig {
    return {
      id: row.id,
      url: row.url,
      secret: row.secret,
      previousSecret: row.previous_secret || undefined,
      secretUpdatedAt: new Date(row.secret_updated_at),
      active: row.active,
      events: row.events as WebhookEventType[],
    };
  }
}
