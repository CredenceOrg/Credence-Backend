/**
 * @module jobs/webhookDlqProcessor
 * @description Background job that replays dead-lettered webhook deliveries.
 *
 * The webhook service permanently-fails a delivery after its retry budget is
 * exhausted and records a {@link DlqEntry}. Nothing else in the system ever
 * revisits those entries, so this job is the only recovery path for a webhook
 * subscriber that was briefly unavailable.
 *
 * ## Invariants
 *
 * 1. **At-least-once, never at-most-once.** An entry is marked replayed *only*
 *    after a delivery has been observed to succeed. A crash between the
 *    successful delivery and `markReplayed` produces a duplicate delivery,
 *    which is the safe failure: subscribers must already be idempotent. The
 *    opposite ordering would silently drop events.
 * 2. **No destructive transitions.** This job never deletes, trims, or mutates
 *    entry content. Every entry — skipped, orphaned, invalid, or failed —
 *    survives the run untouched so an operator can always inspect it.
 * 3. **A failing entry never poisons the batch.** Errors are scoped to the
 *    single entry being replayed; the run continues with the next one.
 * 4. **Replay is bounded.** An entry is attempted at most `maxReplayAttempts`
 *    times (counted via the original delivery's attempt total) and at most
 *    `batchSize` entries are handled per run, so a large backlog cannot
 *    monopolise the process or amplify an outage.
 * 5. **Nothing is delivered before it is safe.** Entries younger than
 *    `minAgeMs` are left alone so a replay never races the in-memory retry
 *    backoff of the original delivery, and entries belonging to a deleted or
 *    deactivated webhook are never sent to a stranger.
 * 6. **Runs are single-flight.** A run already in progress short-circuits
 *    concurrent callers rather than replaying the same entries twice.
 * 7. **Logs carry no payloads or secrets** — only entry ids, webhook ids and
 *    outcome codes.
 *
 * @example
 * ```typescript
 * const processor = new WebhookDlqProcessor(dlqStore, webhookStore, { logger: console.log })
 * processor.start()
 * const result = await processor.run()
 * console.log(`replayed ${result.replayedCount}/${result.eligibleCount}`)
 * ```
 */

import { deliverWebhook, type DeliveryOptions } from '../services/webhooks/delivery.js'
import type {
  DlqEntry,
  DlqStore,
  WebhookConfig,
  WebhookPayload,
  WebhookStore,
} from '../services/webhooks/types.js'

/** Why a DLQ entry was not replayed. Purely diagnostic; safe to log. */
export type DlqSkipReason =
  | 'already_replayed'
  | 'too_recent'
  | 'attempts_exhausted'
  | 'inactive_webhook'
  | 'dry_run'

/** Terminal disposition of a single entry within a run. */
export type DlqEntryOutcome =
  | { status: 'replayed' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: DlqSkipReason }
  /** The owning webhook no longer exists — the entry is retained for inspection. */
  | { status: 'orphaned' }
  /** The stored entry is structurally unusable; retained for manual inspection. */
  | { status: 'invalid'; reason: string }

/** Result of replaying a single entry by id. */
export interface DlqReplayResult {
  entryId: string
  outcome: DlqEntryOutcome
}

export interface WebhookDlqProcessorMetrics {
  incRuns?(): void
  incReplayed?(count: number): void
  incFailed?(count: number): void
  incSkipped?(count: number): void
  observeDuration?(seconds: number): void
}

export interface WebhookDlqProcessorOptions {
  /** Run interval in milliseconds (default: 300000 = 5 minutes). */
  intervalMs?: number
  /** Maximum number of eligible entries replayed per run (default: 100). */
  batchSize?: number
  /**
   * Grace period: an entry must be at least this old (relative to
   * `failedAt`) before it is eligible for replay (default: 60000 = 1 minute).
   */
  minAgeMs?: number
  /**
   * Entries whose original delivery already burned more than this many
   * attempts are treated as exhausted and left for manual inspection
   * (default: 5).
   */
  maxReplayAttempts?: number
  /** Count and classify without delivering or marking anything (default: false). */
  dryRun?: boolean
  /** Options forwarded to the delivery layer. */
  deliveryOptions?: DeliveryOptions
  /** Logger function. Never receives payload or secret material. */
  logger?: (message: string) => void
  /** Optional metrics sink. */
  metrics?: WebhookDlqProcessorMetrics
  /** Clock injection point, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number
}

export interface WebhookDlqProcessorResult {
  /** Entries returned by the DLQ store this run. */
  scannedCount: number
  /**
   * Entries that cleared every pre-flight gate (replayed / age / attempt-cap /
   * structural validity) and were resolved against the webhook store.
   */
  eligibleCount: number
  /** Entries delivered successfully and marked replayed. */
  replayedCount: number
  /** Entries whose delivery threw or reported failure. */
  failedCount: number
  /** Entries deferred by a skip rule (see {@link DlqSkipReason}). */
  skippedCount: number
  /** Entries whose webhook no longer exists. */
  orphanedCount: number
  /** Entries whose stored payload/failedAt was unusable. */
  invalidCount: number
  /** Whether this was a dry run. */
  dryRun: boolean
  /** Whether a run was already in flight and this call was a no-op. */
  concurrentSkip: boolean
  /** Duration in milliseconds. */
  durationMs: number
}

/** Returns `value` when it is a usable non-negative finite number, else `fallback`. */
function nonNegativeOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Same as {@link nonNegativeOrDefault} but rejects 0, so batch sizes stay >= 1. */
function positiveOrDefault(value: number | undefined, fallback: number): number {
  const resolved = nonNegativeOrDefault(value, fallback)
  return resolved >= 1 ? resolved : fallback
}

/**
 * Structural validation of a persisted entry.
 *
 * Returns the normalised payload on success, or a human-readable reason on
 * failure. Validation is deliberately conservative: anything that is not
 * unambiguously deliverable is reported as invalid rather than guessed at,
 * because a malformed send is worse than a deferred one.
 */
export function validateDlqEntry(
  entry: DlqEntry,
): { ok: true; payload: WebhookPayload } | { ok: false; reason: string } {
  if (!entry || typeof entry !== 'object') {
    return { ok: false, reason: 'entry_not_an_object' }
  }
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    return { ok: false, reason: 'missing_id' }
  }
  if (typeof entry.webhookId !== 'string' || entry.webhookId.length === 0) {
    return { ok: false, reason: 'missing_webhook_id' }
  }
  if (typeof entry.failedAt !== 'string' || Number.isNaN(Date.parse(entry.failedAt))) {
    return { ok: false, reason: 'unparseable_failed_at' }
  }
  if (typeof entry.attempts !== 'number' || !Number.isFinite(entry.attempts)) {
    return { ok: false, reason: 'non_numeric_attempts' }
  }

  const payload = entry.payload
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'missing_payload' }
  }
  if (typeof payload.event !== 'string' || payload.event.length === 0) {
    return { ok: false, reason: 'payload_missing_event' }
  }
  if (typeof payload.timestamp !== 'string' || Number.isNaN(Date.parse(payload.timestamp))) {
    return { ok: false, reason: 'payload_unparseable_timestamp' }
  }
  if (!payload.data || typeof payload.data !== 'object') {
    return { ok: false, reason: 'payload_missing_data' }
  }

  return { ok: true, payload }
}

export class WebhookDlqProcessor {
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly minAgeMs: number
  private readonly maxReplayAttempts: number
  private readonly dryRun: boolean
  private readonly deliveryOptions: DeliveryOptions
  private readonly logger: (message: string) => void
  private readonly metrics: WebhookDlqProcessorMetrics
  private readonly now: () => number
  private interval: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly dlqStore: DlqStore,
    private readonly webhookStore: WebhookStore,
    options: WebhookDlqProcessorOptions = {},
  ) {
    this.intervalMs = positiveOrDefault(options.intervalMs, 300_000)
    this.batchSize = positiveOrDefault(options.batchSize, 100)
    this.minAgeMs = nonNegativeOrDefault(options.minAgeMs, 60_000)
    this.maxReplayAttempts = nonNegativeOrDefault(options.maxReplayAttempts, 5)
    this.dryRun = options.dryRun ?? false
    this.deliveryOptions = options.deliveryOptions ?? {}
    this.logger = options.logger ?? (() => {})
    this.metrics = options.metrics ?? {}
    this.now = options.now ?? (() => Date.now())
  }

  /** Start the periodic replay job. Safe to call twice; the second call is ignored. */
  start(): void {
    if (this.interval) {
      this.logger('[WebhookDlqProcessor] Already running')
      return
    }

    this.logger(`[WebhookDlqProcessor] Starting replay loop every ${this.intervalMs}ms`)

    this.run().catch((err) => {
      this.logger(`[WebhookDlqProcessor] Error in initial run: ${describeError(err)}`)
    })

    this.interval = setInterval(() => {
      this.run().catch((err) => {
        this.logger(`[WebhookDlqProcessor] Error in scheduled run: ${describeError(err)}`)
      })
    }, this.intervalMs)
  }

  /** Stop the periodic replay job. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
      this.logger('[WebhookDlqProcessor] Stopped')
    }
  }

  /** Whether a run is currently in flight. */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Run a single replay cycle.
   *
   * Never rejects for a per-entry failure. Rejects only when the DLQ cannot be
   * read at all, in which case the run flag is still released so the next
   * scheduled run can recover.
   */
  async run(): Promise<WebhookDlqProcessorResult> {
    if (this.running) {
      this.logger('[WebhookDlqProcessor] Already running, skipping')
      return this.emptyResult(true)
    }

    this.running = true
    const startTime = this.now()

    const result: WebhookDlqProcessorResult = this.emptyResult(false)

    try {
      const entries = await this.dlqStore.list()
      result.scannedCount = entries.length

      for (const entry of entries) {
        const classification = this.classify(entry)
        if (classification.kind !== 'eligible') {
          this.recordNonEligible(result, entry.id, classification)
          continue
        }

        if (result.eligibleCount >= this.batchSize) {
          // Batch is full. The remainder stays queued for the next run rather
          // than being skipped, so the counter must not advance here.
          result.skippedCount++
          this.logger(
            `[WebhookDlqProcessor] Batch limit of ${this.batchSize} reached, deferring entry ${entry.id}`,
          )
          continue
        }

        result.eligibleCount++
        const outcome = await this.replayEntryInternal(entry, classification.payload)
        this.recordOutcome(result, entry.id, outcome)
      }

      result.durationMs = Math.max(0, this.now() - startTime)

      this.metrics.incRuns?.()
      this.metrics.incReplayed?.(result.replayedCount)
      this.metrics.incFailed?.(result.failedCount)
      this.metrics.incSkipped?.(result.skippedCount)
      this.metrics.observeDuration?.(result.durationMs / 1000)

      this.logger(
        `[WebhookDlqProcessor] Completed: scanned=${result.scannedCount} eligible=${result.eligibleCount} ` +
          `replayed=${result.replayedCount} failed=${result.failedCount} skipped=${result.skippedCount} ` +
          `orphaned=${result.orphanedCount} invalid=${result.invalidCount} dryRun=${this.dryRun} ` +
          `duration=${result.durationMs}ms`,
      )

      return result
    } catch (error) {
      const durationMs = Math.max(0, this.now() - startTime)
      this.logger(`[WebhookDlqProcessor] Error after ${durationMs}ms: ${describeError(error)}`)
      this.metrics.observeDuration?.(durationMs / 1000)
      throw error
    } finally {
      this.running = false
    }
  }

  /**
   * Replay one entry by id, independent of the batch/grace-period gates.
   *
   * Intended for operator-triggered recovery. Unknown ids resolve to
   * `{ status: 'invalid', reason: 'not_found' }` rather than throwing.
   */
  async replayEntry(entryId: string): Promise<DlqReplayResult> {
    const entry = await this.dlqStore.get(entryId)
    if (!entry) {
      return { entryId, outcome: { status: 'invalid', reason: 'not_found' } }
    }

    const validation = validateDlqEntry(entry)
    if (!validation.ok) {
      this.logger(`[WebhookDlqProcessor] Replay refused for ${entryId}: ${validation.reason}`)
      return { entryId, outcome: { status: 'invalid', reason: validation.reason } }
    }

    const webhook = await this.webhookStore.get(entry.webhookId)
    if (!webhook) {
      this.logger(`[WebhookDlqProcessor] Replay skipped for ${entryId}: webhook ${entry.webhookId} not found`)
      return { entryId, outcome: { status: 'orphaned' } }
    }

    if (!webhook.active) {
      this.logger(`[WebhookDlqProcessor] Replay skipped for ${entryId}: webhook ${entry.webhookId} is inactive`)
      return { entryId, outcome: { status: 'skipped', reason: 'inactive_webhook' } }
    }

    if (this.dryRun) {
      return { entryId, outcome: { status: 'skipped', reason: 'dry_run' } }
    }

    const outcome = await this.attemptDelivery(entry, validation.payload, webhook)
    this.logOutcome(entryId, outcome)
    return { entryId, outcome }
  }

  private emptyResult(concurrentSkip: boolean): WebhookDlqProcessorResult {
    return {
      scannedCount: 0,
      eligibleCount: 0,
      replayedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      orphanedCount: 0,
      invalidCount: 0,
      dryRun: this.dryRun,
      concurrentSkip,
      durationMs: 0,
    }
  }

  /**
   * Apply every gate that does not require I/O.
   *
   * Ordered cheapest-first and fail-safe-first: an entry that is already
   * replayed, structurally invalid, or exhausted must never reach the
   * webhook lookup, so a corrupt backlog cannot hammer the store.
   */
  private classify(
    entry: DlqEntry,
  ):
    | { kind: 'eligible'; payload: WebhookPayload }
    | { kind: 'skipped'; reason: DlqSkipReason }
    | { kind: 'invalid'; reason: string } {
    if (entry.replayedAt) {
      return { kind: 'skipped', reason: 'already_replayed' }
    }

    const validation = validateDlqEntry(entry)
    if (!validation.ok) {
      return { kind: 'invalid', reason: validation.reason }
    }

    if (entry.attempts > this.maxReplayAttempts) {
      return { kind: 'skipped', reason: 'attempts_exhausted' }
    }

    const age = this.now() - Date.parse(entry.failedAt)
    if (age < this.minAgeMs) {
      return { kind: 'skipped', reason: 'too_recent' }
    }

    return { kind: 'eligible', payload: validation.payload }
  }

  private recordNonEligible(
    result: WebhookDlqProcessorResult,
    entryId: string,
    classification: { kind: 'skipped'; reason: DlqSkipReason } | { kind: 'invalid'; reason: string },
  ): void {
    if (classification.kind === 'invalid') {
      result.invalidCount++
      this.logger(`[WebhookDlqProcessor] Invalid entry ${entryId}: ${classification.reason}`)
      return
    }
    result.skippedCount++
    this.logger(`[WebhookDlqProcessor] Skipped entry ${entryId}: ${classification.reason}`)
  }

  private recordOutcome(
    result: WebhookDlqProcessorResult,
    entryId: string,
    outcome: DlqEntryOutcome,
  ): void {
    this.logOutcome(entryId, outcome)
    switch (outcome.status) {
      case 'replayed':
        result.replayedCount++
        break
      case 'failed':
        result.failedCount++
        break
      case 'skipped':
        result.skippedCount++
        break
      case 'orphaned':
        result.orphanedCount++
        break
      case 'invalid':
        result.invalidCount++
        break
    }
  }

  /** I/O half of the replay: webhook lookup, then delivery, then mark. */
  private async replayEntryInternal(
    entry: DlqEntry,
    payload: WebhookPayload,
  ): Promise<DlqEntryOutcome> {
    let webhook: WebhookConfig | null
    try {
      webhook = await this.webhookStore.get(entry.webhookId)
    } catch (error) {
      this.logger(
        `[WebhookDlqProcessor] Webhook lookup failed for ${entry.id} (webhook ${entry.webhookId}): ${describeError(error)}`,
      )
      return { status: 'failed', error: describeError(error) }
    }

    if (!webhook) {
      this.logger(
        `[WebhookDlqProcessor] Orphaned entry ${entry.id}: webhook ${entry.webhookId} no longer exists`,
      )
      return { status: 'orphaned' }
    }

    if (!webhook.active) {
      return { status: 'skipped', reason: 'inactive_webhook' }
    }

    if (this.dryRun) {
      return { status: 'skipped', reason: 'dry_run' }
    }

    return this.attemptDelivery(entry, payload, webhook)
  }

  /**
   * Deliver and, only on success, mark the entry replayed.
   *
   * The mark deliberately comes last: a failure there means the entry stays
   * queued and will be delivered again next run (at-least-once).
   */
  private async attemptDelivery(
    entry: DlqEntry,
    payload: WebhookPayload,
    webhook: WebhookConfig,
  ): Promise<DlqEntryOutcome> {
    let succeeded: boolean
    try {
      const delivery = await deliverWebhook(webhook, payload, this.deliveryOptions)
      succeeded = Array.isArray(delivery)
        ? delivery.length > 0 && delivery.every(r => r.success)
        : delivery.success
    } catch (error) {
      // A thrown error is a failed delivery, not a failed run.
      return { status: 'failed', error: describeError(error) }
    }

    if (!succeeded) {
      return { status: 'failed', error: 'delivery_unsuccessful' }
    }

    try {
      await this.dlqStore.markReplayed(entry.id, new Date(this.now()).toISOString())
    } catch (error) {
      // Delivery succeeded but the mark did not stick. Count it as failed so it
      // is retried; the duplicate is the acceptable outcome.
      return { status: 'failed', error: `mark_replayed_failed: ${describeError(error)}` }
    }

    return { status: 'replayed' }
  }

  private logOutcome(entryId: string, outcome: DlqEntryOutcome): void {
    switch (outcome.status) {
      case 'replayed':
        this.logger(`[WebhookDlqProcessor] Replayed entry ${entryId}`)
        break
      case 'failed':
        this.logger(`[WebhookDlqProcessor] Replay of entry ${entryId} failed: ${outcome.error}`)
        break
      case 'skipped':
        this.logger(`[WebhookDlqProcessor] Skipped entry ${entryId}: ${outcome.reason}`)
        break
      case 'orphaned':
        this.logger(`[WebhookDlqProcessor] Orphaned entry ${entryId}: webhook no longer exists`)
        break
      case 'invalid':
        this.logger(`[WebhookDlqProcessor] Invalid entry ${entryId}: ${outcome.reason}`)
        break
    }
  }
}

/** Reduce an unknown throwable to a message without leaking a stack trace. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Standalone single-cycle helper for one-off executions or tests. */
export async function processWebhookDlq(
  dlqStore: DlqStore,
  webhookStore: WebhookStore,
  options?: WebhookDlqProcessorOptions,
): Promise<WebhookDlqProcessorResult> {
  return new WebhookDlqProcessor(dlqStore, webhookStore, options).run()
}
