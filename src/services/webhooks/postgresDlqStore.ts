import { Pool } from 'pg'
import type { DlqEntry, DlqStore, WebhookPayload } from './types.js'
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

  async list(): Promise<DlqEntry[]> {
    const result = await this.pool.query(
      `SELECT
        id, webhook_id, payload, failed_at, attempts,
        last_status_code, last_error, response_body_snippet, replayed_at
       FROM webhook_dlq
       ORDER BY failed_at DESC`
    )

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
      failedAt: row.failed_at.toISOString(),
      attempts: row.attempts,
      lastStatusCode: row.last_status_code ?? undefined,
      lastError: row.last_error ?? undefined,
      responseBodySnippet: row.response_body_snippet ?? undefined,
      replayedAt: row.replayed_at ? row.replayed_at.toISOString() : undefined,
    }
  }
}
