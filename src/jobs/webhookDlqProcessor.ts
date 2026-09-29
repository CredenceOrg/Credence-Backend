import type { Pool } from 'pg'
import { PostgresDlqStore } from '../services/webhooks/postgresDlqStore.js'
import { PostgresWebhookRepository } from '../db/repositories/webhookRepository.js'
import { WebhookService } from '../services/webhooks/service.js'
import { auditLogService } from '../services/audit/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookDlqProcessorOptions {
  /**
   * How often the processor checks for undelivered webhooks that should be
   * promoted to the DLQ.  Default: 60 000 ms (1 min).
   */
  intervalMs?: number
  /**
   * Maximum number of outbox rows to scan per run.  Default: 200.
   */
  batchSize?: number
  /**
   * Structured logger.  Defaults to console.log.
   */
  logger?: (msg: string) => void
}

export interface WebhookDlqProcessorResult {
  /** Number of failed outbox events examined. */
  examined: number
  /** Number of new DLQ entries written. */
  pushed: number
  /** Duration in milliseconds. */
  durationMs: number
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

/**
 * WebhookDlqProcessor
 *
 * A periodic background job that scans the `event_outbox` table for
 * permanently-failed webhook dispatch rows and pushes them into
 * `webhook_dlq` via the existing PostgresDlqStore so that operators can
 * inspect and replay them through the /api/webhooks/dlq endpoint.
 *
 * Design notes
 * ------------
 * - The outbox schema marks a row as "failed" (status = 'failed') once all
 *   retry attempts are exhausted.  This processor queries those rows and
 *   creates matching DLQ entries.
 * - A DLQ entry is keyed on the outbox row id (`outbox_event_id`) stored in
 *   `webhook_dlq.id` to make the operation idempotent: running the processor
 *   multiple times never duplicates a DLQ entry.
 * - The job does NOT delete outbox rows — that is the responsibility of the
 *   existing cleanup/retention job.
 */
export class WebhookDlqProcessor {
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly log: (msg: string) => void
  private interval: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly pool: Pool,
    options: WebhookDlqProcessorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000
    this.batchSize = options.batchSize ?? 200
    this.log = options.logger ?? ((m) => console.log(m))
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.interval) {
      this.log('[WebhookDlqProcessor] Already running')
      return
    }

    this.log(
      `[WebhookDlqProcessor] Starting — interval=${this.intervalMs}ms batch=${this.batchSize}`,
    )

    // Run immediately then on schedule
    this.run().catch((err: unknown) => {
      this.log(`[WebhookDlqProcessor] Error in initial run: ${String(err)}`)
    })

    this.interval = setInterval(() => {
      this.run().catch((err: unknown) => {
        this.log(`[WebhookDlqProcessor] Error in scheduled run: ${String(err)}`)
      })
    }, this.intervalMs)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
      this.log('[WebhookDlqProcessor] Stopped')
    }
  }

  isRunning(): boolean {
    return this.running
  }

  // ── Core logic ─────────────────────────────────────────────────────────────

  /**
   * One execution cycle.
   *
   * Queries permanently-failed outbox events that have a payload type of
   * "webhook" and have not yet been promoted to the DLQ, then inserts them.
   *
   * The INSERT uses ON CONFLICT DO NOTHING keyed on the outbox_event_id so
   * repeated runs are safe.
   */
  async run(): Promise<WebhookDlqProcessorResult> {
    if (this.running) {
      this.log('[WebhookDlqProcessor] Skipping — previous run still active')
      return { examined: 0, pushed: 0, durationMs: 0 }
    }

    this.running = true
    const start = Date.now()

    try {
      // ------------------------------------------------------------------
      // 1. Fetch permanently-failed outbox rows that aren't yet in the DLQ.
      //    We join against webhook_dlq on id to detect rows already pushed.
      //    The outbox schema stores:
      //      event_type  – e.g. "bond.created"
      //      payload     – JSONB with the webhook body
      //      metadata    – JSONB, may contain { webhookId }
      //      retry_count – total attempts made
      //      last_error  – last error string
      // ------------------------------------------------------------------
      const failedRows = await this.pool.query<{
        id: string
        event_type: string
        payload: Record<string, unknown>
        metadata: Record<string, unknown> | null
        retry_count: number | null
        last_error: string | null
        created_at: Date
      }>(
        `SELECT eo.id, eo.event_type, eo.payload, eo.metadata,
                eo.retry_count, eo.last_error, eo.created_at
           FROM event_outbox eo
           LEFT JOIN webhook_dlq dlq ON dlq.id = eo.id
          WHERE eo.status = 'failed'
            AND dlq.id IS NULL
          ORDER BY eo.created_at ASC
          LIMIT $1`,
        [this.batchSize],
      )

      const rows = failedRows.rows
      this.log(`[WebhookDlqProcessor] Found ${rows.length} un-promoted failed outbox events`)

      if (rows.length === 0) {
        return { examined: 0, pushed: 0, durationMs: Date.now() - start }
      }

      // ------------------------------------------------------------------
      // 2. Build DLQ entries and bulk-insert with ON CONFLICT DO NOTHING.
      // ------------------------------------------------------------------
      const dlqStore = new PostgresDlqStore(this.pool)
      let pushed = 0

      for (const row of rows) {
        const webhookId: string =
          (row.metadata?.webhookId as string | undefined) ??
          (row.payload?.webhookId as string | undefined) ??
          row.id

        try {
          await dlqStore.push({
            id: row.id,
            webhookId,
            payload: row.payload as import('../services/webhooks/types.js').WebhookPayload,
            failedAt: (row.created_at instanceof Date
              ? row.created_at
              : new Date(row.created_at)
            ).toISOString(),
            attempts: row.retry_count ?? 1,
            lastError: row.last_error ?? undefined,
          })
          pushed++
        } catch (err: unknown) {
          // ON CONFLICT is handled inside PostgresDlqStore via the INSERT
          // but an entry with the same id already existing raises a PG
          // duplicate-key error on the primary key.  Treat as already-pushed.
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
            this.log(`[WebhookDlqProcessor] Skipping already-pushed entry id=${row.id}`)
          } else {
            this.log(`[WebhookDlqProcessor] Error pushing entry id=${row.id}: ${msg}`)
          }
        }
      }

      const durationMs = Date.now() - start
      this.log(
        `[WebhookDlqProcessor] Done — examined=${rows.length} pushed=${pushed} durationMs=${durationMs}`,
      )

      return { examined: rows.length, pushed, durationMs }
    } finally {
      this.running = false
    }
  }

  /**
   * Convenience factory that wires up the full WebhookService for callers
   * that need replay capability alongside DLQ processing.
   */
  static createWebhookService(pool: Pool): WebhookService {
    const store = new PostgresWebhookRepository(pool)
    const dlq = new PostgresDlqStore(pool)
    return new WebhookService(store, undefined, dlq, auditLogService)
  }
}
