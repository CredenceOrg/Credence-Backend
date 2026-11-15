import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import type {
  DlqEntry,
  DlqListOptions,
  DlqReplayAttemptInput,
  DlqStore,
  WebhookPayload,
} from './types.js'
import { recordWebhookDlqSize } from '../../middleware/metrics.js'

export class PostgresDlqStore implements DlqStore {
  constructor(private readonly pool: Pool) {}

  async push(entry: DlqEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_dlq (
        id, webhook_id, payload, failed_at, attempts,
        last_status_code, last_error, response_body_snippet, replayed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.id,
        entry.webhookId,
        JSON.stringify(entry.payload),
        entry.failedAt,
        entry.attempts,
        entry.lastStatusCode ?? null,
        entry.lastError ?? null,
        entry.responseBodySnippet ?? null,
        entry.replayedAt ?? null
      ]
    )
    await this.updateMetrics()
  }

  async list(options?: DlqListOptions): Promise<DlqEntry[]> {
    if (!options || (options.pendingOnly === undefined && options.limit === undefined)) {
      const result = await this.pool.query(
        `SELECT
          id, webhook_id, payload, failed_at, attempts,
          last_status_code, last_error, response_body_snippet, replayed_at
         FROM webhook_dlq
         ORDER BY failed_at DESC`
      )

      return result.rows.map(this.mapRowToEntry)
    }

    const conditions: string[] = []
    const params: unknown[] = []

    if (options.pendingOnly) {
      conditions.push('replayed_at IS NULL')
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}\n       ` : ''
    let limitClause = ''
    if (options.limit !== undefined) {
      params.push(Math.max(0, Math.floor(options.limit)))
      limitClause = `\n       LIMIT $${params.length}`
    }

    const sql = `SELECT
        id, webhook_id, payload, failed_at, attempts,
        last_status_code, last_error, response_body_snippet, replayed_at
       FROM webhook_dlq
       ${whereClause}ORDER BY failed_at DESC${limitClause}`

    const result = params.length > 0 ? await this.pool.query(sql, params) : await this.pool.query(sql)
    return result.rows.map(this.mapRowToEntry)
  }

  async get(id: string): Promise<DlqEntry | null> {
    const result = await this.pool.query(
      `SELECT
        id, webhook_id, payload, failed_at, attempts,
        last_status_code, last_error, response_body_snippet, replayed_at
       FROM webhook_dlq
       WHERE id = $1`,
      [id]
    )

    if (result.rows.length === 0) {
      return null
    }

    return this.mapRowToEntry(result.rows[0])
  }

  async markReplayed(id: string, replayedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_dlq
       SET replayed_at = $2
       WHERE id = $1`,
      [id, replayedAt]
    )
  }

  async replayAttempts(entryId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) AS count FROM webhook_replay_audit WHERE dlq_entry_id = $1`,
      [entryId]
    )
    return parseInt(String(result.rows[0]?.count ?? '0'), 10)
  }

  async recordReplayAttempt(input: DlqReplayAttemptInput): Promise<void> {
    const id = randomUUID()
    const replayedAt = new Date().toISOString()

    await this.pool.query(
      `INSERT INTO webhook_replay_audit (
        id, dlq_entry_id, webhook_id, actor_id, actor_email, tenant_id,
        idempotency_key, replayed_at, success, status_code, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (dlq_entry_id, idempotency_key) DO NOTHING`,
      [
        id,
        input.dlqEntryId,
        input.webhookId,
        input.actorId,
        input.actorEmail,
        input.tenantId,
        input.idempotencyKey,
        replayedAt,
        input.success,
        input.statusCode ?? null,
        input.errorMessage ?? null,
      ]
    )
  }

  private async updateMetrics(): Promise<void> {
    try {
      const result = await this.pool.query('SELECT count(*) as count FROM webhook_dlq')
      recordWebhookDlqSize(parseInt(result.rows[0].count, 10))
    } catch (err) {
      console.error('[PostgresDlqStore] Failed to update DLQ size metric', err)
    }
  }

  private mapRowToEntry(row: any): DlqEntry {
    return {
      id: row.id,
      webhookId: row.webhook_id,
      payload: row.payload as WebhookPayload,
      failedAt: row.failed_at instanceof Date ? row.failed_at.toISOString() : String(row.failed_at),
      attempts: row.attempts,
      lastStatusCode: row.last_status_code ?? undefined,
      lastError: row.last_error ?? undefined,
      responseBodySnippet: row.response_body_snippet ?? undefined,
      replayedAt: row.replayed_at
        ? row.replayed_at instanceof Date
          ? row.replayed_at.toISOString()
          : String(row.replayed_at)
        : undefined,
    }
  }
}
