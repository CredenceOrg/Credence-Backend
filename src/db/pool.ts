import { Pool, type PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

/**
 * Parse a numeric environment variable with a fallback default.
 * Returns the fallback if the variable is missing or non-numeric.
 * @internal Exported for testing only.
 */
export function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const DB_URL = process.env.DB_URL;
const POOL_MAX = envInt("DB_POOL_MAX", 20);
const IDLE_TIMEOUT = envInt("DB_POOL_IDLE_TIMEOUT_MS", 30_000);
const CONN_TIMEOUT = envInt("DB_POOL_CONNECTION_TIMEOUT_MS", 5_000);
const STMT_TIMEOUT = envInt("DB_STATEMENT_TIMEOUT_MS", 30_000);
const WORKER_MAX = envInt("DB_WORKER_POOL_MAX", 5);

const DB_REPLICA_URL = process.env.DB_REPLICA_URL || DB_URL;
const MAX_REPLICA_LAG_MS = envInt("MAX_REPLICA_LAG_MS", 1000);

/**
 * Primary API pool — serves route handlers and services.
 *
 * Configured with a default statement_timeout so that runaway queries
 * are killed automatically and cannot hold connections indefinitely.
 */
export const pool = new Pool({
  connectionString: DB_URL,
  max: POOL_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT,
  connectionTimeoutMillis: CONN_TIMEOUT,
  options: `-c statement_timeout=${STMT_TIMEOUT}`,
});

pool.on("error", (err) => {
  console.error("[pool] unexpected client error", err);
});

/**
 * Worker pool — bounded budget for background jobs (outbox, exports, reports).
 *
 * Runs with a smaller connection limit so that long-running background
 * work cannot starve the API pool of connections. The statement_timeout
 * is 4× longer than the API pool since report/export jobs are inherently
 * slower.
 */
export const workerPool = new Pool({
  connectionString: DB_URL,
  max: WORKER_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT,
  connectionTimeoutMillis: CONN_TIMEOUT,
  options: `-c statement_timeout=${STMT_TIMEOUT * 4}`,
});

workerPool.on("error", (err) => {
  console.error("[workerPool] unexpected client error", err);
});

/**
 * Secondary API pool — serves read-heavy endpoints.
 */
export const replicaPool = new Pool({
  connectionString: DB_REPLICA_URL,
  max: POOL_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT,
  connectionTimeoutMillis: CONN_TIMEOUT,
  options: `-c statement_timeout=${STMT_TIMEOUT}`,
});

replicaPool.on("error", (err) => {
  console.error("[replicaPool] unexpected client error", err);
});

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
      // In a real application, you might use a proper logger instead of console.warn
      console.warn(`[withReplica] Replica error or lag exceeded, falling back to primary`, err);
      return await operation(pool);
    }
    throw err;
  }
}