import { Pool, type PoolClient, type QueryResult } from "pg";
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { AppError, ErrorCode } from "../lib/errors.js";
import { logger } from "../utils/logger.js";
import { getTenantId } from "../utils/tenantContext.js";
import { redact } from "../observability/redaction.js";
import { LogEventType } from "../observability/logSchemas.js";
import { loadConfig } from "../config/index.js";

/**
 * Parse a numeric environment variable with a fallback default.
 * Returns the fallback if the variable is missing or non-numeric.
 * @internal Exported for testing only.
 * @deprecated Pool configuration is now sourced from the validated config
 * module (DB_POOL_MAX, DB_WORKER_POOL_MAX, DB_REPLICA_POOL_MAX, etc. — see
 * src/config/index.ts). Kept only for DB_TENANT_CONNECTION_BUDGET, which has
 * no fixed default and is derived from POOL_MAX below. New pool settings
 * should be added to the config module instead (#887).
 */
export function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Single source of truth for every pool tuning knob — validated once at
// startup by src/config/index.ts rather than read ad hoc via process.env
// throughout this module. See issue #887.
const cfg = loadConfig();

const DB_URL = cfg.db.url;
const POOL_MAX = cfg.db.pool.max;
const IDLE_TIMEOUT = cfg.db.pool.idleTimeoutMillis;
const CONN_TIMEOUT = cfg.db.pool.connectionTimeoutMillis;
const STMT_TIMEOUT = cfg.db.pool.statementTimeoutMs;
const WORKER_MAX = cfg.db.workerPool.max;
const REPLICA_MAX = cfg.db.replicaPool.max;

/**
 * Minimum query duration (ms) that triggers a slow-query log entry with the
 * query's EXPLAIN plan attached. 0 disables slow-query logging entirely.
 * See docs/observability.md#slow-query-logging.
 */
const SLOW_QUERY_THRESHOLD_MS = cfg.db.slowQueryThresholdMs;

const DB_REPLICA_URL = process.env.DB_REPLICA_URL || DB_URL;
const MAX_REPLICA_LAG_MS = cfg.db.maxReplicaLagMs;
const TENANT_CONNECTION_BUDGET = Math.max(1, Math.min(envInt("DB_TENANT_CONNECTION_BUDGET", Math.max(1, Math.floor(POOL_MAX / 4))), POOL_MAX));
const tenantConnectionCounts = new Map<string, number>();

export class TenantConnectionBudgetError extends AppError {
  constructor(
    public readonly tenantId: string,
    public readonly limit: number,
  ) {
    super(
      `Tenant ${tenantId} exceeded its DB connection budget of ${limit}`,
      ErrorCode.RATE_LIMIT_EXCEEDED,
      undefined,
      { tenantId, limit, resource: 'db_connection_budget' },
    );
    this.name = "TenantConnectionBudgetError";
  }
}

function wrapTenantBudgetedClient(client: PoolClient, tenantId: string): PoolClient {
  const release = client.release.bind(client);
  const key = tenantId;

  client.release = ((err?: Error | boolean) => {
    const active = tenantConnectionCounts.get(key) ?? 0;
    if (active <= 1) {
      tenantConnectionCounts.delete(key);
    } else {
      tenantConnectionCounts.set(key, active - 1);
    }
    return release(err);
  }) as typeof client.release;

  return client;
}

function withTenantConnectionBudget(pool: Pool): Pool {
  const originalConnect = pool.connect.bind(pool);

  pool.connect = (async () => {
    const tenantId = getTenantId();
    if (!tenantId) {
      return await originalConnect();
    }

    const activeConnections = tenantConnectionCounts.get(tenantId) ?? 0;
    if (activeConnections >= TENANT_CONNECTION_BUDGET) {
      throw new TenantConnectionBudgetError(tenantId, TENANT_CONNECTION_BUDGET);
    }

    const client = await originalConnect();
    tenantConnectionCounts.set(tenantId, activeConnections + 1);
    return wrapTenantBudgetedClient(client, tenantId);
  }) as typeof pool.connect;

  return pool;
}

/**
 * Primary API pool — serves route handlers and services.
 *
 * Configured with a default statement_timeout so that runaway queries
 * are killed automatically and cannot hold connections indefinitely.
 */
export const pool = withTenantConnectionBudget(new Pool({
  connectionString: DB_URL,
  max: POOL_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT,
  connectionTimeoutMillis: CONN_TIMEOUT,
  options: `-c statement_timeout=${STMT_TIMEOUT}`,
}));

pool.on("error", (err) => {
  logger.error("[pool] unexpected client error", err);
});

/**
 * Worker pool — bounded budget for background jobs (outbox, exports, reports).
 *
 * Runs with a smaller connection limit so that long-running background
 * work cannot starve the API pool of connections. The statement_timeout
 * is 4× longer than the API pool since report/export jobs are inherently
 * slower.
 */
export const workerPool = withTenantConnectionBudget(new Pool({
  connectionString: DB_URL,
  max: WORKER_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT,
  connectionTimeoutMillis: CONN_TIMEOUT,
  options: `-c statement_timeout=${STMT_TIMEOUT * 4}`,
}));

workerPool.on("error", (err) => {
  logger.error("[workerPool] unexpected client error", err);
});

/**
 * Secondary API pool — serves read-heavy endpoints.
 */
export const replicaPool = withTenantConnectionBudget(new Pool({
  connectionString: DB_REPLICA_URL,
  max: REPLICA_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT,
  connectionTimeoutMillis: CONN_TIMEOUT,
  options: `-c statement_timeout=${STMT_TIMEOUT}`,
}));

replicaPool.on("error", (err) => {
  logger.error("[replicaPool] unexpected client error", err);
});

type PoolName = "api" | "worker" | "replica";

/** Maximum characters of query text kept in a slow-query log line. */
const MAX_LOGGED_QUERY_LENGTH = 4_000;

function truncateQueryText(text: string): string {
  return text.length > MAX_LOGGED_QUERY_LENGTH
    ? `${text.slice(0, MAX_LOGGED_QUERY_LENGTH)}…[truncated]`
    : text;
}

function extractQueryText(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first) {
    const text = (first as { text?: unknown }).text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

function extractQueryParams(args: unknown[]): unknown[] | undefined {
  const first = args[0];
  if (first && typeof first === "object" && "values" in first) {
    const values = (first as { values?: unknown }).values;
    return Array.isArray(values) ? values : undefined;
  }
  return Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined;
}

/**
 * Per-pool LRU cache mapping exact query text to a stable, deterministic
 * prepared-statement name. Bounded by `DB_PREPARED_STATEMENT_CACHE_MAX` to
 * protect server-side prepared-statement memory (each distinct name is
 * remembered per physical connection). See docs/observability.md#prepared-statement-cache.
 *
 * The name is derived purely from the query text (a hash), never from an
 * incrementing counter. That's deliberate: if a name were reused for two
 * *different* query texts, a pg connection that already parsed the old text
 * under that name would skip re-parsing on the next call (per node-postgres's
 * per-connection `parsedStatements` tracking) and silently execute the wrong
 * SQL. A pure hash of the text means eviction-then-reintroduction always maps
 * back to the exact same name, so that corruption case cannot happen.
 */
export const apiPreparedStatementCache = new LRUCache<string, string>({
  max: cfg.db.preparedStatementCacheMax,
});
export const workerPreparedStatementCache = new LRUCache<string, string>({
  max: cfg.db.preparedStatementCacheMax,
});
export const replicaPreparedStatementCache = new LRUCache<string, string>({
  max: cfg.db.preparedStatementCacheMax,
});

function statementNameFor(text: string): string {
  return `qs_${createHash("sha1").update(text).digest("hex").slice(0, 16)}`;
}

/**
 * PostgreSQL's extended query protocol cannot PREPARE more than one command
 * at a time — reject text containing multiple semicolon-separated statements
 * rather than caching (and later reusing) a name for it.
 */
function isSingleStatement(text: string): boolean {
  return !text.trim().replace(/;\s*$/, "").includes(";");
}

/**
 * Wraps `target.query` so that repeat executions of the same query text reuse
 * a server-side prepared statement (via a stable `name`) instead of being
 * re-parsed by Postgres on every call. Falls through unmodified for
 * callback-style calls, calls that already specify an explicit `name`, and
 * text this module cannot safely name (multi-statement text, or no
 * extractable text at all).
 * @internal Exported for testing only.
 */
export function instrumentPreparedStatementCache(
  target: Pool,
  cache: LRUCache<string, string>
): void {
  const originalQuery = target.query.bind(target) as (...args: unknown[]) => unknown;

  target.query = ((...args: unknown[]) => {
    if (typeof args[args.length - 1] === "function") {
      return originalQuery(...args);
    }

    const first = args[0];
    if (first && typeof first === "object" && "name" in first && (first as { name?: unknown }).name) {
      // Caller already chose an explicit name — respect it untouched.
      return originalQuery(...args);
    }

    const text = extractQueryText(args);
    if (!text || !isSingleStatement(text)) {
      return originalQuery(...args);
    }

    let name = cache.get(text);
    if (!name) {
      name = statementNameFor(text);
      cache.set(text, name);
    }

    if (first && typeof first === "object") {
      // Preserve any other QueryConfig fields (rowMode, types, etc.).
      return originalQuery({ ...(first as object), name });
    }

    return originalQuery({ name, text, values: extractQueryParams(args) });
  }) as unknown as Pool["query"];
}

/**
 * Logs a slow-query event (with EXPLAIN plan) once `durationMs` exceeds
 * `thresholdMs`. Uses plain `EXPLAIN` — never `EXPLAIN ANALYZE` — because
 * ANALYZE re-executes the statement, which would duplicate side effects for
 * mutating queries (INSERT/UPDATE/DELETE). Bind parameter *values* are
 * never logged, only the parameterized query text and the estimated plan,
 * so this cannot leak PII/secrets passed as query parameters.
 */
async function reportIfSlow(
  originalQuery: (...args: unknown[]) => Promise<QueryResult>,
  poolName: PoolName,
  thresholdMs: number,
  args: unknown[],
  startedAt: bigint
): Promise<void> {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  if (durationMs < thresholdMs) return;

  const text = extractQueryText(args);
  if (!text) return;

  // Imported lazily (rather than at module top level) so that constructing
  // a Pool never has a side effect on prom-client's global metrics
  // registry — module-reload-heavy tests (e.g. pool.test.ts) re-evaluate
  // this file's top level repeatedly, which would otherwise re-register
  // the same metric name and throw.
  const { dbSlowQueriesTotal, dbSlowQueryDurationSeconds } = await import("../observability/customMetrics.js");
  dbSlowQueriesTotal.inc({ pool: poolName });
  dbSlowQueryDurationSeconds.observe({ pool: poolName }, durationMs / 1000);

  // Best-effort: if EXPLAIN itself fails (e.g. the statement isn't
  // EXPLAIN-able in isolation), still emit the slow-query log below with
  // plan omitted rather than losing the timing signal entirely.
  let plan: string | undefined;
  try {
    const params = extractQueryParams(args);
    const explainResult = await originalQuery(`EXPLAIN (FORMAT JSON) ${text}`, params);
    const planJson = explainResult.rows[0]?.["QUERY PLAN"];
    plan = planJson !== undefined ? truncateQueryText(JSON.stringify(planJson)) : undefined;
  } catch {
    plan = undefined;
  }

  logger.warn(
    redact(
      {
        eventType: LogEventType.DB_SLOW_QUERY,
        message: "Slow query exceeded threshold",
        query: truncateQueryText(text),
        durationMs: Math.round(durationMs),
        thresholdMs,
        pool: poolName,
        plan,
      },
      { eventType: LogEventType.DB_SLOW_QUERY }
    )
  );
}

/**
 * Wraps `target.query` so that any call taking at least `thresholdMs`
 * (default `SLOW_QUERY_THRESHOLD_MS`) is logged together with its EXPLAIN
 * plan. A `thresholdMs` of 0 disables instrumentation.
 * @internal Exported for testing only.
 */
export function instrumentSlowQueryLogging(
  target: Pool,
  poolName: PoolName,
  thresholdMs: number = SLOW_QUERY_THRESHOLD_MS
): void {
  if (thresholdMs <= 0) return;

  const originalQuery = target.query.bind(target) as (...args: unknown[]) => unknown;

  target.query = ((...args: unknown[]) => {
    // Callback-style calls aren't used anywhere in this codebase; pass them
    // through unmodified rather than instrumenting a shape we can't time.
    if (typeof args[args.length - 1] === "function") {
      return originalQuery(...args);
    }

    const startedAt = process.hrtime.bigint();
    const result = originalQuery(...args) as Promise<QueryResult>;

    return result.then(
      (res) => {
        void reportIfSlow(
          originalQuery as (...a: unknown[]) => Promise<QueryResult>,
          poolName,
          thresholdMs,
          args,
          startedAt
        );
        return res;
      },
      (err) => {
        void reportIfSlow(
          originalQuery as (...a: unknown[]) => Promise<QueryResult>,
          poolName,
          thresholdMs,
          args,
          startedAt
        );
        throw err;
      }
    );
  }) as unknown as Pool["query"];
}

import { trace, SpanStatusCode } from "@opentelemetry/api";

export function instrumentQueryTracing(target: Pool, poolName: PoolName): void {
  const originalQuery = target.query.bind(target) as (...args: unknown[]) => unknown;

  target.query = ((...args: unknown[]) => {
    // Callback-style calls aren't used anywhere in this codebase; pass them
    // through unmodified.
    if (typeof args[args.length - 1] === "function") {
      return originalQuery(...args);
    }

    const text = extractQueryText(args) || "unknown";
    const tracer = trace.getTracer("credence-backend");

    return tracer.startActiveSpan("db.query", async (span) => {
      span.setAttribute("db.system", "postgresql");
      span.setAttribute("db.statement", text);
      span.setAttribute("db.pool", poolName);

      try {
        const result = await (originalQuery(...args) as Promise<QueryResult>);
        if (result && typeof result.rowCount === "number") {
          span.setAttribute("db.row_count", result.rowCount);
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : "Unknown error",
        });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }) as unknown as Pool["query"];
}

instrumentSlowQueryLogging(pool, "api");
instrumentQueryTracing(pool, "api");
instrumentPreparedStatementCache(pool, apiPreparedStatementCache);

instrumentSlowQueryLogging(workerPool, "worker");
instrumentQueryTracing(workerPool, "worker");
instrumentPreparedStatementCache(workerPool, workerPreparedStatementCache);

instrumentSlowQueryLogging(replicaPool, "replica");
instrumentQueryTracing(replicaPool, "replica");
instrumentPreparedStatementCache(replicaPool, replicaPreparedStatementCache);

// ── Pool Saturation Monitor ───────────────────────────────────────────────────
// Polls every 10s and emits a warning when saturation exceeds 80%.

const SATURATION_THRESHOLD = 0.80;

interface PoolSaturationFrame {
  pool: string;
  activeConnections: number;
  idleConnections: number;
  pendingRequests: number;
  maxPoolSize: number;
  saturationRatio: number;
}

function checkPoolSaturation(
  p: Pool,
  maxSize: number,
  poolName: string,
): PoolSaturationFrame | null {
  const activeConnections = p.totalCount - p.idleCount;
  const saturationRatio = maxSize > 0 ? activeConnections / maxSize : 0;
  if (saturationRatio <= SATURATION_THRESHOLD) return null;
  return {
    pool: poolName,
    activeConnections,
    idleConnections: p.idleCount,
    pendingRequests: p.waitingCount,
    maxPoolSize: maxSize,
    saturationRatio,
  };
}

function pollPoolSaturation(): void {
  for (const entry of [
    { p: pool, max: POOL_MAX, name: "api" },
    { p: workerPool, max: WORKER_MAX, name: "worker" },
    { p: replicaPool, max: REPLICA_MAX, name: "replica" },
  ] as const) {
    const frame = checkPoolSaturation(entry.p, entry.max, entry.name);
    if (frame) {
      logger.warn({
        eventType: LogEventType.GENERIC_WARN,
        message: "Pool saturation exceeds threshold",
        pool: frame.pool,
        activeConnections: frame.activeConnections,
        pendingRequests: frame.pendingRequests,
        maxPoolSize: frame.maxPoolSize,
        saturationRatio: Math.round(frame.saturationRatio * 100) / 100,
      });
    }
  }
}

const SATURATION_POLL_INTERVAL_MS = 10_000;
const saturationTimer = setInterval(pollPoolSaturation, SATURATION_POLL_INTERVAL_MS);
saturationTimer.unref();

/**
 * Helper to execute an operation on the replica, falling back to primary
 * if the replica is lagging or disconnected.
 */
export async function withReplica<T>(
  operation: (client: Pool | PoolClient) => Promise<T>,
  options: { maxLagMs?: number; fallback?: boolean } = {}
): Promise<T> {
  const maxLagMs = options.maxLagMs ?? MAX_REPLICA_LAG_MS;
  const fallback = options.fallback ?? true;

  try {
    const { rows } = await replicaPool.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000, 0) as lag_ms`
    );
    const lagMs = rows[0]?.lag_ms ?? 0;

    if (lagMs > maxLagMs) {
      if (!fallback) {
        throw new Error(`Replica lag too high: ${lagMs}ms`);
      }
      return await operation(pool);
    }

    return await operation(replicaPool);
  } catch (err) {
    if (fallback) {
      logger.warn(`[withReplica] Replica error or lag exceeded, falling back to primary: ${err instanceof Error ? err.message : err}`);
      return await operation(pool);
    }
    throw err;
  }
}
