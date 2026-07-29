import { randomUUID } from 'crypto'
import type { Queryable } from '../db/repositories/queryable.js'
import type { DlqEntry, WebhookPayload } from '../services/webhooks/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayAuditRow {
  id: string
  dlq_entry_id: string
  webhook_id: string
  actor_id: string
  actor_email: string
  tenant_id: string
  idempotency_key: string
  replayed_at: string
  success: boolean
  status_code?: number
  error_message?: string
  ip_address?: string
  request_id?: string
}

export interface RecordReplayInput {
  dlqEntryId: string
  webhookId: string
  actorId: string
  actorEmail: string
  tenantId: string
  idempotencyKey: string
  success: boolean
  statusCode?: number
  errorMessage?: string
  ipAddress?: string
  requestId?: string
}

export interface ListDlqOptions {
  /** Max rows to return (default 100, max 500). */
  limit?: number
  /** Offset for keyset-style pagination. */
  beforeId?: string
  /** Only return un-replayed entries. */
  pendingOnly?: boolean
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * WebhookDlqRepository wraps both the `webhook_dlq` table (read/update) and
 * the `webhook_replay_audit` table (write-once append).
 *
 * It deliberately does NOT expose a raw `push()` method — new DLQ entries
 * are written by PostgresDlqStore (owned by WebhookService).  This repository
 * is the read path used by the replay route and admin UIs.
 */
export class WebhookDlqRepository {
  constructor(private readonly db: Queryable) {}

  // ── DLQ reads ──────────────────────────────────────────────────────────────

  /**
   * Return a single DLQ entry by id, or null if not found.
   */
  async findById(id: string): Promise<DlqEntry | null> {
    const result = await this.db.query<{
      id: string
      webhook_id: string
      payload: WebhookPayload
      failed_at: Date
      attempts: number
      last_status_code: number | null
      last_error: string | null
      response_body_snippet: string | null
      replayed_at: Date | null
    }>(
      `SELECT
        id, webhook_id, payload, failed_at, attempts,
        last_status_code, last_error, response_body_snippet, replayed_at
       FROM webhook_dlq
       WHERE id = $1`,
      [id],
    )
    if (result.rows.length === 0) return null
    return this.mapRow(result.rows[0])
  }

  /**
   * List DLQ entries, newest-first with optional filtering.
   */
  async list(opts: ListDlqOptions = {}): Promise<DlqEntry[]> {
    const limit = Math.min(opts.limit ?? 100, 500)
    const conditions: string[] = []
    const params: unknown[] = []

    if (opts.pendingOnly) {
      conditions.push('replayed_at IS NULL')
    }
    if (opts.beforeId) {
      params.push(opts.beforeId)
      // Cursor-based pagination: rows whose failed_at < the anchor row's failed_at
      conditions.push(
        `failed_at < (SELECT failed_at FROM webhook_dlq WHERE id = $${params.length})`,
      )
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(limit)

    const result = await this.db.query<{
      id: string
      webhook_id: string
      payload: WebhookPayload
      failed_at: Date
      attempts: number
      last_status_code: number | null
      last_error: string | null
      response_body_snippet: string | null
      replayed_at: Date | null
    }>(
      `SELECT
        id, webhook_id, payload, failed_at, attempts,
        last_status_code, last_error, response_body_snippet, replayed_at
       FROM webhook_dlq
       ${where}
       ORDER BY failed_at DESC
       LIMIT $${params.length}`,
      params,
    )

    return result.rows.map((r) => this.mapRow(r))
  }

  /**
   * Mark a DLQ entry as replayed (idempotent; safe to call multiple times).
   */
  async markReplayed(id: string, replayedAt: Date = new Date()): Promise<void> {
    await this.db.query(
      `UPDATE webhook_dlq SET replayed_at = $2 WHERE id = $1`,
      [id, replayedAt.toISOString()],
    )
  }

  // ── Replay audit ───────────────────────────────────────────────────────────

  /**
   * Append a replay audit record.
   *
   * ON CONFLICT DO NOTHING means that if the same idempotency key is submitted
   * twice, the second call is a no-op and returns null (not an error).  Callers
   * should treat null as "already recorded — treat as success".
   */
  async recordReplay(input: RecordReplayInput): Promise<ReplayAuditRow | null> {
    const id = randomUUID()
    const now = new Date().toISOString()

    const result = await this.db.query<ReplayAuditRow>(
      `INSERT INTO webhook_replay_audit (
        id, dlq_entry_id, webhook_id, actor_id, actor_email, tenant_id,
        idempotency_key, replayed_at, success, status_code, error_message,
        ip_address, request_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT ON CONSTRAINT uq_webhook_replay_audit_idempotency
      DO NOTHING
      RETURNING *`,
      [
        id,
        input.dlqEntryId,
        input.webhookId,
        input.actorId,
        input.actorEmail,
        input.tenantId,
        input.idempotencyKey,
        now,
        input.success,
        input.statusCode ?? null,
        input.errorMessage ?? null,
        input.ipAddress ?? null,
        input.requestId ?? null,
      ],
    )

    return result.rows[0] ?? null
  }

  /**
   * Fetch the replay audit history for a given DLQ entry, newest-first.
   */
  async getReplayHistory(dlqEntryId: string): Promise<ReplayAuditRow[]> {
    const result = await this.db.query<ReplayAuditRow>(
      `SELECT
        id, dlq_entry_id, webhook_id, actor_id, actor_email, tenant_id,
        idempotency_key, replayed_at, success, status_code, error_message,
        ip_address, request_id
       FROM webhook_replay_audit
       WHERE dlq_entry_id = $1
       ORDER BY replayed_at DESC`,
      [dlqEntryId],
    )
    return result.rows
  }

  /**
   * Check whether a specific idempotency key has already been recorded
   * for a given DLQ entry.  Used by the route to short-circuit replay.
   */
  async findByIdempotencyKey(
    dlqEntryId: string,
    idempotencyKey: string,
  ): Promise<ReplayAuditRow | null> {
    const result = await this.db.query<ReplayAuditRow>(
      `SELECT * FROM webhook_replay_audit
       WHERE dlq_entry_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [dlqEntryId, idempotencyKey],
    )
    return result.rows[0] ?? null
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private mapRow(row: {
    id: string
    webhook_id: string
    payload: WebhookPayload
    failed_at: Date
    attempts: number
    last_status_code: number | null
    last_error: string | null
    response_body_snippet: string | null
    replayed_at: Date | null
  }): DlqEntry {
    return {
      id: row.id,
      webhookId: row.webhook_id,
      payload: row.payload,
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
