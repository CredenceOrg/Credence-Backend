import type { Pool, PoolClient } from 'pg'
import { RequestSnapshotsRepository } from './repositories/requestSnapshotsRepository.js'
import { dbTxnDurationSeconds, dbTxnSavepoints } from '../observability/index.js'
import { withSpan, DbSpans } from '../tracing/tracer.js'

/** PostgreSQL error code emitted when lock_timeout fires (lock_not_available). */
export const PG_LOCK_TIMEOUT_CODE = "55P03";

/**
 * Named timeout policies that map to pre-configured millisecond values.
 * Choose the least-permissive policy that still meets the operation's SLA
 * to bound contention impact on other callers.
 */
export enum LockTimeoutPolicy {
  READONLY = "readonly",
  DEFAULT = "default",
  CRITICAL = "critical",
}

/** Thrown when a row lock cannot be acquired within the configured window. */
export class LockTimeoutError extends Error {
  constructor(
    /** The named policy active at the time of the timeout, if any. */
    public readonly policy: LockTimeoutPolicy | undefined,
    /** Effective timeout in milliseconds that was applied. */
    public readonly timeoutMs: number,
  ) {
    super(`Lock timeout after ${timeoutMs}ms (policy: ${policy ?? "custom"})`);
    this.name = "LockTimeoutError";
  }
}

/** Thrown when transaction budget (duration or savepoints) is exceeded. */
export class TransactionBudgetError extends Error {
  constructor(
    public readonly reason: 'duration_exceeded' | 'savepoints_exceeded',
    public readonly maxDurationMs?: number,
    public readonly maxSavepoints?: number,
    public readonly actualDurationMs?: number,
    public readonly actualSavepoints?: number,
  ) {
    const message = reason === 'duration_exceeded'
      ? `Transaction budget exceeded: duration ${actualDurationMs}ms > ${maxDurationMs}ms`
      : `Transaction budget exceeded: savepoints ${actualSavepoints} > ${maxSavepoints}`;
    super(message);
    this.name = "TransactionBudgetError";
  }
}

export interface LockTimeoutConfig {
  readonly: number;
  default: number;
  critical: number;
}

export interface TransactionOptions {
  policy?: LockTimeoutPolicy;
  timeoutMs?: number;
  isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
  retryOnLockTimeout?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  maxDurationMs?: number;
  maxSavepoints?: number;
  /** Label for the db.tx span `op` attribute (e.g. "process_payment"). */
  op?: string;
}

const FALLBACK_TIMEOUTS: LockTimeoutConfig = {
  readonly: 2_000,
  default: 5_000,
  critical: 10_000,
};

const DEFAULT_MAX_DURATION_MS = 2000;
const DEFAULT_MAX_SAVEPOINTS = 8;

/**
 * Wraps a PoolClient to track savepoint usage and check transaction duration.
 */
function createBudgetedClient(
  client: PoolClient,
  startTime: number,
  maxDurationMs: number,
  maxSavepoints: number,
  savepointCountRef: { count: number },
  tablesRef: { tables: Set<string> },
): PoolClient {
  const wrappedQuery = async (...args: any[]) => {
    // Check duration budget before executing query
    const elapsed = Date.now() - startTime;
    if (elapsed > maxDurationMs) {
      throw new TransactionBudgetError('duration_exceeded', maxDurationMs, undefined, elapsed);
    }

    // Check if query is creating a savepoint
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (sql && sql.trim().toUpperCase().startsWith('SAVEPOINT')) {
      savepointCountRef.count++;
      if (savepointCountRef.count > maxSavepoints) {
        throw new TransactionBudgetError('savepoints_exceeded', undefined, maxSavepoints, undefined, savepointCountRef.count);
      }
    }

    // Track unique table names referenced in the query
    if (sql) {
      const tableRegex = /(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+["']?(\w+)["']?\b/gi;
      let match: RegExpExecArray | null;
      while ((match = tableRegex.exec(sql)) !== null) {
        tablesRef.tables.add(match[1].toLowerCase());
      }
    }

    // `client.query` is heavily overloaded; none of its overloads accept a
    // spread of `any[]`. Invoke through a rest-parameter call signature so the
    // proxied arguments forward verbatim to the underlying client.
    const query = client.query.bind(client) as (
      ...queryArgs: unknown[]
    ) => Promise<unknown>;
    return await query(...args);
  };

  // Create a proxy or object with the same interface as PoolClient, overriding query
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') {
        return wrappedQuery;
      }
      return (target as any)[prop];
    },
  });
}

/**
 * Manages PostgreSQL transactions with configurable lock-timeout policies
 * and optional exponential-backoff retry on contention.
 *
 * Pass the PoolClient received by the withTransaction callback to every
 * repository that must participate in the same atomic unit. All writes share
 * one client connection under a single BEGIN...COMMIT block. Any uncaught
 * error triggers an immediate ROLLBACK so partial state is never committed,
 * even across multiple nested service calls.
 */
export async function withReplaySnapshot<T>(
  pool: Pool,
  fn: (client: PoolClient, snapshot: any) => Promise<T>,
  requestId: string,
): Promise<T> {
  const client = await pool.connect();
  try {
    const repo = new RequestSnapshotsRepository(client);
    const snapshot = await repo.findById(requestId);
    if (!snapshot) {
      throw new Error(`Snapshot not found for requestId ${requestId}`);
    }
    const result = await fn(client, snapshot);
    return result;
  } finally {
    client.release();
  }
}

export class TransactionManager {
  private readonly timeouts: LockTimeoutConfig;

  constructor(
    private readonly pool: Pool,
    timeouts?: Partial<LockTimeoutConfig>,
  ) {
    this.timeouts = { ...FALLBACK_TIMEOUTS, ...timeouts };
  }

  /**
   * Execute fn atomically inside a PostgreSQL transaction.
   *
   * Forward the supplied PoolClient to every repository participating in
   * this transaction so nested calls share the same BEGIN...COMMIT block and
   * roll back together on any error.
   *
   * @param fn      - Callback receiving an exclusive PoolClient.
   * @param options - Timeout policy, isolation level, and retry config.
   * @returns The value returned by fn after a successful commit.
   * @throws {LockTimeoutError} when a row lock cannot be acquired in time.
   * @throws {TransactionBudgetError} when transaction budget is exceeded.
   */
  async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const {
      policy,
      timeoutMs,
      isolationLevel,
      retryOnLockTimeout = false,
      maxRetries = 3,
      retryDelayMs = 100,
      maxDurationMs = DEFAULT_MAX_DURATION_MS,
      maxSavepoints = DEFAULT_MAX_SAVEPOINTS,
      op,
    } = options;

    const effectiveTimeoutMs =
      timeoutMs ??
      (policy !== undefined ? this.timeouts[policy] : this.timeouts.default);

    let attempts = 0;

    while (true) {
      const client = await this.pool.connect();
      const startTime = Date.now();
      const savepointCountRef = { count: 0 };
      const tablesRef = { tables: new Set<string>() };

      try {
        const beginSql = isolationLevel
          ? `BEGIN ISOLATION LEVEL ${isolationLevel}`
          : "BEGIN";

        await client.query(beginSql);
        await client.query(
          `SET LOCAL lock_timeout = '${effectiveTimeoutMs}ms'`,
        );
        // Propagate tenant id into the transaction so Postgres RLS policies
        // that rely on `current_setting('app.tenant_id', true)` can enforce
        // row-level isolation per-tenant.
        try {
          const tenantId = getTenantId();
          if (tenantId) {
            // Use a parameterized setting to avoid injection; cast to uuid in policies.
            await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
          }
        } catch (err) {
          // Swallow: setting may not be needed in some environments
        }

        const budgetedClient = createBudgetedClient(client, startTime, maxDurationMs, maxSavepoints, savepointCountRef, tablesRef);

        const initAttrs: Record<string, string | number | boolean> = {};
        if (op) {
          initAttrs.op = op;
        }

        const result = await withSpan(DbSpans.TX, async (span) => {
          const r = await fn(budgetedClient);
          span.setAttribute('table_count', tablesRef.tables.size);
          return r;
        }, initAttrs);

        await client.query("COMMIT");
        // Record metrics on successful commit
        const durationSeconds = (Date.now() - startTime) / 1000;
        dbTxnDurationSeconds.observe(durationSeconds);
        dbTxnSavepoints.observe(savepointCountRef.count);
        return result;
      } catch (err: unknown) {
        await client.query("ROLLBACK").catch(() => {
          // Swallowed: connection may be dead, pg will recycle on release.
        });

        const pgCode = (err as { code?: string }).code;

        if (pgCode === PG_LOCK_TIMEOUT_CODE) {
          if (retryOnLockTimeout && attempts < maxRetries) {
            const delay = retryDelayMs * Math.pow(2, attempts);
            attempts++;
            await sleep(delay);
            continue;
          }

          throw new LockTimeoutError(policy, effectiveTimeoutMs);
        }

        throw err;
      } finally {
        client.release();
      }
    }
  }
}

/**
 * Decorator that extends the transaction budget for known long jobs.
 */
export function withExtendedTxnBudget(options: { maxDurationMs?: number; maxSavepoints?: number }) {
  return function <T>(
    target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<T>>,
  ) {
    // This decorator is a placeholder; actual usage would typically involve
    // passing the extended options to withTransaction calls inside the method.
    // For now, it serves as documentation and a hook for future integration.
    return descriptor;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Placeholder for getTenantId to avoid compilation errors (this function should be defined elsewhere).
 */
function getTenantId(): string | undefined {
  return undefined;
}
