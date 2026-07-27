/**
 * Analytics materialized-view refresh strategy.
 *
 * Centralises the "tick" of the analytics refresh job:
 *
 *   1. For each registered view, get a **dedicated** Postgres client from the
 *      pool, scope `statement_timeout` to that client, run
 *      `REFRESH MATERIALIZED VIEW CONCURRENTLY <view>`, then `RESET
 *      statement_timeout` and release.
 *
 *   2. The dedicated-clients pattern keeps the timeout **per-view** (so a
 *      huge view can have a generous `statementTimeoutMs` without affecting
 *      unrelated traffic) and keeps session state out of the pool — if the
 *      RESET fails after a `REFRESH` blow-up, the next pool consumer will
 *      still see the pool-default `statement_timeout` once they reconnect.
 *
 *   3. Each view refresh is wrapped in a bounded retry loop keyed on
 *      Postgres `SQLSTATE` codes for transient failures (`40001`,
 *      `40P01`, `55P03`, `57P03`, `08000/...`, `53300`, plus the optional
 *      `57014 query_canceled`). Non-transient errors fail immediately
 *      so we surface persistent bugs quickly.
 *
 *   4. The cache-generation token (`bumpAnalyticsCacheGeneration`) is
 *      bumped **only when every registered view refreshed successfully**.
 *      Mixing generations would mean readers see some views at gen N and
 *      others at gen N+1, which is impossible to reason about
 *      coherently.
 *
 *   5. `analytics_view_refresh_state` is updated on every attempt (last
 *      attempt + last error path) and on success (last success + cleared
 *      error + duration). A row MUST exist for every registered view; the
 *      caller should add it via migration. The strategy logs a hard error
 *      rather than silently treating 0 rows-affected as success.
 *
 * Lock exposure is the explicit goal here: REFRESH CONCURRENTLY grabs a
 * `SHARE UPDATE EXCLUSIVE` lock that blocks autovacuum and DDL but NOT
 * readers. Without a per-view `statement_timeout`, a slow REFRESH can hold
 * that lock for minutes on a busy table, starving autovacuum and stalling
 * the database. Timeouts cap that exposure at the cost of having to retry.
 */

import type { Pool, QueryResult, QueryResultRow } from 'pg'
import { logger } from '../../utils/logger.js'
import { bumpAnalyticsCacheGeneration } from './cacheGeneration.js'
import { withSpan } from '../../tracing/tracer.js'

/** Name of the registry table that tracks per-view refresh state. */
export const ANALYTICS_REFRESH_STATE_TABLE = 'analytics_view_refresh_state'

/**
 * One analytics view managed by the strategy. Each spec MUST have a
 * corresponding row in `analytics_view_refresh_state` (the initial
 * migration inserts one for `analytics_metrics_mv`); a refresh for a
 * spec with no row is logged loudly but treated as a failure.
 */
export interface AnalyticsViewSpec {
  /** View name as it appears in the SQL identifier. */
  name: string
  /** `statement_timeout` applied to the dedicated client before refreshing. */
  statementTimeoutMs: number
}

/**
 * Postgres SQLSTATE classes the strategy treats as **transient** and
 * retries. The set is conservative — anything not listed fails fast so
 * persistent bugs surface immediately.
 *
 * - `40001` serialization_failure
 * - `40P01` deadlock_detected
 * - `55P03` lock_not_available
 * - `57P03` cannot_connect_now (during a primary failover)
 * - `08000`–`08007` connection-class
 * - `53300` too_many_connections
 * - `57014` query_canceled (i.e. `statement_timeout` hit; retry may
 *   complete faster on a fresh plan or after autovacuum).
 */
export type TransientErrorKind =
  | 'serialization_failure'
  | 'deadlock_detected'
  | 'lock_not_available'
  | 'cannot_connect_now'
  | 'connection_exception'
  | 'too_many_connections'
  | 'query_canceled'

export const TRANSIENT_SQLSTATE: Record<string, TransientErrorKind> = {
  '40001': 'serialization_failure',
  '40P01': 'deadlock_detected',
  '55P03': 'lock_not_available',
  '57P03': 'cannot_connect_now',
  '08000': 'connection_exception',
  '08001': 'connection_exception',
  '08003': 'connection_exception',
  '08004': 'connection_exception',
  '08006': 'connection_exception',
  '08007': 'connection_exception',
  '53300': 'too_many_connections',
  '57014': 'query_canceled',
}

const DEFAULT_TRANSIENT_KINDS: ReadonlySet<TransientErrorKind> = new Set<TransientErrorKind>([
  'serialization_failure',
  'deadlock_detected',
  'lock_not_available',
  'cannot_connect_now',
  'connection_exception',
  'too_many_connections',
  'query_canceled',
])

export interface TransientDbError {
  kind: TransientErrorKind
  sqlState: string
  message: string
}

/**
 * Inspects a thrown value and (if it carries a Postgres SQLSTATE) returns
 * its transient classification. Returns `null` for non-transient or
 * non-Postgres errors so callers can fail fast.
 */
export function classifyTransientDbError(err: unknown): TransientDbError | null {
  if (!err || typeof err !== 'object') return null
  const sqlState = (err as { code?: unknown }).code
  if (typeof sqlState !== 'string' || sqlState.length !== 5) return null
  const kind = TRANSIENT_SQLSTATE[sqlState]
  if (kind === undefined) return null
  const message = err instanceof Error ? err.message : String(err)
  return { kind, sqlState, message }
}

/** Per-view outcome. */
export interface ViewRefreshOutcome {
  view: string
  refreshed: boolean
  durationMs: number
  attempts: number
  /** Set on failure. */
  error?: { kind: TransientErrorKind | 'permanent'; message: string; sqlState?: string }
}

/** Aggregate result of one full refresh tick. */
export interface RefreshStrategyResult {
  refreshedViews: string[]
  failedViews: ViewRefreshOutcome[]
  totalDurationMs: number
  /** Cache generation bumped. Undefined if any view failed. */
  cacheGeneration?: number
  /** Per-view transient retry counters. */
  transientRetryCount: Record<string, Record<TransientErrorKind, number>>
}

/** Optional metrics interface the strategy calls into. */
export interface AnalyticsRefreshMetrics {
  incRuns(status: 'success' | 'error', view: string): void
  observeDuration(seconds: number, view: string): void
  incTransientRetry(view: string, kind: TransientErrorKind): void
  setCacheGeneration(value: number): void
}

/**
 * Minimal Postgres client interface returned by `Connectable.connect()` so the
 * strategy can be tested with a stub that doesn't have to implement pg's full
 * `PoolClient` API. Production code returns a real `PoolClient` which
 * already has these methods.
 */
export interface AnalyticsClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>
  release(): void
}

/**
 * Minimal Postgres interface the strategy needs. Kept as small as possible
 * so tests can stub it; production code always passes the real `Pool` from
 * `src/db/pool.ts`.
 */
export interface Connectable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>
  connect(): Promise<AnalyticsClient>
}

/**
 * The strategy is constructed once and reused across ticks. The constructor
 * does NOT start any timer — the caller (worker / scheduler) decides when
 * to invoke `refreshAll()`.
 */
export interface AnalyticsRefreshStrategyOptions {
  /**
   * Postgres pool used to obtain dedicated clients via `connect()`. Must
   * support `connect()`; in production this is the worker pool
   * (`workerPool` in `src/db/pool.ts`).
   */
  pool: Connectable
  /** Views to refresh each tick, in order. */
  views: AnalyticsViewSpec[]
  /** Max attempts per view, including the first. Default: 3. */
  maxAttemptsPerView?: number
  /** Backoff (ms) between attempts. Default: 1000. */
  retryBackoffMs?: number
  /**
   * Override the default transient kinds. Pass `new Set(['query_canceled'])` to
   * disable retries on `statement_timeout`, for instance.
   */
  transientRetryKinds?: ReadonlySet<TransientErrorKind>
  /** Optional metrics sink. */
  metrics?: AnalyticsRefreshMetrics
  /** Logger. */
  logger?: (msg: string) => void
  /** Injectable clock (default: `Date`). */
  clock?: () => Date
  /** Injectable sleep (default: `setTimeout`). */
  sleep?: (ms: number) => Promise<void>
}

/** Default view spec — the canonical `analytics_metrics_mv`. */
export const DEFAULT_ANALYTICS_VIEW_SPECS: ReadonlyArray<AnalyticsViewSpec> = [
  { name: 'analytics_metrics_mv', statementTimeoutMs: 60_000 },
]

const DEFAULT_MAX_ATTEMPTS_PER_VIEW = 3
const DEFAULT_RETRY_BACKOFF_MS = 1_000

export class AnalyticsRefreshStrategy {
  private readonly pool: Connectable
  private readonly views: AnalyticsViewSpec[]
  private readonly maxAttemptsPerView: number
  private readonly retryBackoffMs: number
  private readonly transientRetryKinds: ReadonlySet<TransientErrorKind>
  private readonly metrics?: AnalyticsRefreshMetrics
  private readonly log: (msg: string) => void
  private readonly clock: () => Date
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: AnalyticsRefreshStrategyOptions) {
    if (options.views.length === 0) {
      throw new Error('AnalyticsRefreshStrategy requires at least one view')
    }
    if (options.pool == null) {
      throw new Error('AnalyticsRefreshStrategy requires a Postgres pool')
    }
    this.pool = options.pool
    this.views = options.views
    this.maxAttemptsPerView = options.maxAttemptsPerView ?? DEFAULT_MAX_ATTEMPTS_PER_VIEW
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
    this.transientRetryKinds = options.transientRetryKinds ?? DEFAULT_TRANSIENT_KINDS
    this.metrics = options.metrics
    this.log = options.logger ?? ((msg) => logger.info(msg))
    this.clock = options.clock ?? (() => new Date())
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  }

  /**
   * Refresh every registered view serially with retry-on-transient and
   * per-view metrics. Returns the aggregate outcome including a bumped
   * cache generation iff every view succeeded.
   *
   * The whole tick is wrapped in a top-level tracing span
   * `analytics.refresh_all` and each view in `analytics.refresh_view`.
   */
  async refreshAll(): Promise<RefreshStrategyResult> {
    return withSpan('analytics.refresh_all', async () => {
      const startedAt = this.clock().getTime()
      const refreshedViews: string[] = []
      const failedViews: ViewRefreshOutcome[] = []
      const transientRetryCount: Record<string, Record<TransientErrorKind, number>> = {}

      for (const view of this.views) {
        transientRetryCount[view.name] = transientRetryCount[view.name] ?? {}
        const outcome = await withSpan(
          'analytics.refresh_view',
          () => this.refreshViewWithRetry(view, transientRetryCount[view.name]),
          { 'analytics.view': view.name, 'statement_timeout_ms': view.statementTimeoutMs },
        )
        if (outcome.refreshed) refreshedViews.push(view.name)
        else failedViews.push(outcome)
      }

      const result: RefreshStrategyResult = {
        refreshedViews,
        failedViews,
        totalDurationMs: this.clock().getTime() - startedAt,
        transientRetryCount,
      }

      // ALL-or-NONE: only bump the cache generation when every view
      // succeeded. Mixing generations would mean readers see views at
      // different points in time, which is impossible to reason about.
      if (failedViews.length === 0) {
        const generation = bumpAnalyticsCacheGeneration()
        result.cacheGeneration = generation
        this.metrics?.setCacheGeneration(generation)
        this.log(
          `[analytics] refresh_all ok — refreshed ${refreshedViews.length}/${this.views.length} view(s), cacheGen=${generation} durationMs=${result.totalDurationMs}`,
        )
      } else {
        this.log(
          `[analytics] refresh_all degraded — refreshed ${refreshedViews.length}/${this.views.length}, failed=${failedViews.map((v) => v.view).join(',')} durationMs=${result.totalDurationMs}`,
        )
      }

      return result
    })
  }

  /**
   * Refresh one view with bounded retry on transient Postgres errors.
   * State-table writes for transient retries go through the same dedicated
   * client (handled inside `refreshViewOnce`); terminal errors are
   * recorded on a separate client so a transport-level blow-up doesn't
   * prevent the error row from being written.
   */
  private async refreshViewWithRetry(
    view: AnalyticsViewSpec,
    retryTally: Record<TransientErrorKind, number>,
  ): Promise<ViewRefreshOutcome> {
    let lastError: ViewRefreshOutcome['error'] | undefined

    for (let attempt = 1; attempt <= this.maxAttemptsPerView; attempt++) {
      const viewStartedAt = this.clock().getTime()
      try {
        await this.refreshViewOnce(view)
        const durationMs = this.clock().getTime() - viewStartedAt
        this.metrics?.incRuns('success', view.name)
        this.metrics?.observeDuration(durationMs / 1000, view.name)
        return { view: view.name, refreshed: true, durationMs, attempts: attempt }
      } catch (error) {
        const durationMs = this.clock().getTime() - viewStartedAt
        const transient = classifyTransientDbError(error)
        const exhaustedAttempts = attempt >= this.maxAttemptsPerView
        const isTransient = transient !== null && this.transientRetryKinds.has(transient.kind)
        const willRetry = isTransient && !exhaustedAttempts

        // Record `last_error` only on the terminal attempt so we don't
        // emit noisy intermediate rows that would be immediately clobbered
        // by a successful retry.
        if (!willRetry) {
          await this.recordViewError(
            view,
            transient?.message ??
              (error instanceof Error ? error.message : String(error)),
            durationMs,
          ).catch(() => undefined)
        }

        if (transient !== null && willRetry) {
          retryTally[transient.kind] = (retryTally[transient.kind] ?? 0) + 1
          this.metrics?.incTransientRetry(view.name, transient.kind)
          this.log(
            `[analytics] refresh_view transient retry view=${view.name} attempt=${attempt}/${this.maxAttemptsPerView} kind=${transient.kind} sqlState=${transient.sqlState} backoffMs=${this.retryBackoffMs}`,
          )
          await this.sleep(this.retryBackoffMs)
          continue
        }

        // Either non-transient, or transient but attempts exhausted.
        lastError = transient
          ? {
              kind: transient.kind,
              sqlState: transient.sqlState,
              message: transient.message,
            }
          : {
              kind: 'permanent',
              message: error instanceof Error ? error.message : String(error),
            }
        this.metrics?.incRuns('error', view.name)
        this.metrics?.observeDuration(durationMs / 1000, view.name)
        return {
          view: view.name,
          refreshed: false,
          durationMs,
          attempts: attempt,
          error: lastError,
        }
      }
    }

    // Unreachable: the for-loop always returns or falls through to
    // an in-loop `return`. Keep this as a type-system safety net.
    return {
      view: view.name,
      refreshed: false,
      durationMs: 0,
      attempts: this.maxAttemptsPerView,
      error: lastError ?? { kind: 'permanent', message: 'exhausted attempts' },
    }
  }

  /**
   * Execute one REFRESH attempt on a dedicated client. The
   * `statement_timeout` is scoped to the dedicated client for the
   * duration of the REFRESH, then RESET in a `finally` so the connection
   * returned to the pool has its session state restored.
   */
  private async refreshViewOnce(view: AnalyticsViewSpec): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query(
        `SET statement_timeout = ${Math.max(0, Math.floor(view.statementTimeoutMs))}`,
      )
      try {
        // Mark this attempt in flight BEFORE the REFRESH starts so a stuck
        // refresh is observable via SQL:
        //   SELECT view_name, last_attempt_at FROM analytics_view_refresh_state
        //   WHERE last_attempt_at > NOW() - INTERVAL '1 hour'
        //     AND (last_success_at IS NULL OR last_success_at < last_attempt_at);
        await client.query(
          `UPDATE ${ANALYTICS_REFRESH_STATE_TABLE}
           SET last_attempt_at = NOW(), updated_at = NOW()
           WHERE view_name = $1`,
          [view.name],
        )

        await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${quoteIdent(view.name)}`)
      } finally {
        // RESET (not SET 0) returns the session to the pool default. Done
        // in a finally so it runs even if REFRESH threw. A RESET failure
        // is logged but does not block release — the connection's
        // statement_timeout will revert on subsequent reconnect anyway.
        try {
          await client.query('RESET statement_timeout')
        } catch (resetErr) {
          this.log(
            `[analytics] reset statement_timeout failed for view=${view.name}: ${
              resetErr instanceof Error ? resetErr.message : String(resetErr)
            }`,
          )
        }
      }
    } finally {
      // Always release, even if RESET threw.
      try {
        client.release()
      } catch {
        // Pool-side release errors are not actionable here; the pool will
        // reclaim the connection.
      }
    }
  }

  /** Best-effort write of last_error on the state row. */
  private async recordViewError(
    view: AnalyticsViewSpec,
    message: string,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE ${ANALYTICS_REFRESH_STATE_TABLE}
         SET last_error = $2,
             duration_ms = $3,
             updated_at = NOW()
         WHERE view_name = $1`,
        [view.name, message, Math.max(0, Math.floor(durationMs))],
      )
    } catch (recordErr) {
      this.log(
        `[analytics] recordViewError failed view=${view.name}: ${
          recordErr instanceof Error ? recordErr.message : String(recordErr)
        }`,
      )
    }
  }
}

/**
 * Lightweight SQL identifier quoting. We only ever pass view names
 * registered in the codebase; reject anything that wouldn't survive a
 * strict Postgres identifier regex as a defense-in-depth measure even
 * though `pg` already parameterizes the queries we issue.
 */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe analytics view identifier: ${JSON.stringify(name)}`)
  }
  return `"${name}"`
}

/**
 * Type guard: ensure the input is something the strategy can plug into
 * `pool()`. Production passes a real `pg.Pool`; tests pass a custom
 * Connectable.
 */
export function isPoolLike(value: unknown): value is Connectable {
  if (!value || typeof value !== 'object') return false
  const v = value as { query?: unknown; connect?: unknown }
  return typeof v.query === 'function' && typeof v.connect === 'function'
}

/**
 * Adapter: turns a plain `Queryable` into a `Connectable`. Used in tests
 * only — production code always passes a real `pg.Pool`.
 */
export function requirePoolLike(value: unknown): Connectable & Pool {
  if (!isPoolLike(value)) {
    throw new Error('AnalyticsRefreshStrategy requires a Postgres pool with connect() support')
  }
  return value as Connectable & Pool
}
