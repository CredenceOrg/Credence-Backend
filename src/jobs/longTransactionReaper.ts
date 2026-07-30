import type { Queryable } from "../db/repositories/queryable.js";
import client from "prom-client";

/**
 * Configuration for the long-transaction reaper.
 *
 * `DB_STATEMENT_TIMEOUT_MS` (see `src/db/pool.ts`) only bounds a single
 * statement — it resets on every new statement within a transaction, so it
 * does nothing for an idle-in-transaction session (no statement is running)
 * or a transaction built from many small, individually-fast statements
 * separated by slow application-level work. Either shape holds row/table
 * locks and blocks autovacuum for as long as the transaction stays open,
 * which is exactly the "hold-off cascade" this job guards against: waiters
 * queue up behind the stale locks, their own connections stay checked out
 * of the pool while they wait, and the pool eventually saturates.
 */
export interface LongTransactionReaperConfig {
  /** Transactions open longer than this are terminated. Default: 30_000 (30s). */
  maxTransactionAgeMs: number;
  /** How often to scan pg_stat_activity for over-age transactions. Default: 10_000 (10s). */
  intervalMs: number;
  /** Master on/off switch. Default: true. */
  enabled: boolean;
  /** When true, over-age transactions are logged/counted but not terminated. Default: false. */
  dryRun: boolean;
}

export const DEFAULT_LONG_TRANSACTION_REAPER_CONFIG: LongTransactionReaperConfig = {
  maxTransactionAgeMs: 30_000,
  intervalMs: 10_000,
  enabled: true,
  dryRun: false,
};

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true";
}

/**
 * Loads reaper configuration from environment variables, falling back to
 * `defaults` for anything unset or invalid. Pure function (no module-level
 * `process.env` reads) so it can be exercised with an arbitrary env map in
 * tests without resetting modules.
 */
export function loadLongTransactionReaperConfig(
  env: Record<string, string | undefined> = process.env,
  defaults: LongTransactionReaperConfig = DEFAULT_LONG_TRANSACTION_REAPER_CONFIG,
): LongTransactionReaperConfig {
  return {
    maxTransactionAgeMs: parsePositiveMs(env.DB_LONG_TRANSACTION_MAX_AGE_MS, defaults.maxTransactionAgeMs),
    intervalMs: parsePositiveMs(env.DB_LONG_TRANSACTION_REAPER_INTERVAL_MS, defaults.intervalMs),
    enabled: parseBool(env.DB_LONG_TRANSACTION_REAPER_ENABLED, defaults.enabled),
    dryRun: parseBool(env.DB_LONG_TRANSACTION_REAPER_DRY_RUN, defaults.dryRun),
  };
}

/**
 * Raised when a reaper scan fails outright (e.g. the database connection is
 * unavailable). Callers must catch and log this rather than let it escape —
 * a failed scan should never crash the process, since that would take down
 * the very safety net this job exists to provide.
 */
export class LongTransactionReaperError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LongTransactionReaperError";
  }
}

interface LongTransactionRow {
  pid: number;
  usename: string | null;
  application_name: string | null;
  datname: string | null;
  query: string | null;
  age_seconds: string | number;
  terminated?: boolean | null;
}

export interface TerminatedTransaction {
  pid: number;
  usename: string | null;
  applicationName: string | null;
  datname: string | null;
  query: string | null;
  ageSeconds: number;
  terminated: boolean;
}

export interface LongTransactionReaperResult {
  scannedAt: string;
  durationMs: number;
  /** Transactions found older than the configured max age. */
  candidateCount: number;
  /** Of the candidates, how many actually had their backend terminated (0 in dry-run). */
  terminatedCount: number;
  terminated: TerminatedTransaction[];
  dryRun: boolean;
}

/**
 * Scans for and terminates over-age transactions in a single round trip.
 * Restricted to the current database and ordinary client connections so the
 * reaper never touches another database's sessions, replication/background
 * workers, or its own backend.
 */
const TERMINATE_QUERY = `
  SELECT
    pid,
    usename,
    application_name,
    datname,
    LEFT(query, 200) AS query,
    EXTRACT(EPOCH FROM (now() - xact_start)) AS age_seconds,
    pg_terminate_backend(pid) AS terminated
  FROM pg_stat_activity
  WHERE xact_start IS NOT NULL
    AND xact_start < now() - ($1 || ' seconds')::interval
    AND pid <> pg_backend_pid()
    AND datname = current_database()
    AND backend_type = 'client backend'
`;

const SCAN_QUERY = `
  SELECT
    pid,
    usename,
    application_name,
    datname,
    LEFT(query, 200) AS query,
    EXTRACT(EPOCH FROM (now() - xact_start)) AS age_seconds
  FROM pg_stat_activity
  WHERE xact_start IS NOT NULL
    AND xact_start < now() - ($1 || ' seconds')::interval
    AND pid <> pg_backend_pid()
    AND datname = current_database()
    AND backend_type = 'client backend'
`;

let terminatedTotal: client.Counter<string> | undefined;
let terminatedAgeSeconds: client.Histogram<string> | undefined;

function createTerminatedCounter(register?: client.Registry): client.Counter<string> {
  return new client.Counter({
    name: "pg_long_transactions_terminated_total",
    help: "Total PostgreSQL backends terminated for holding a transaction open past DB_LONG_TRANSACTION_MAX_AGE_MS",
    registers: register ? [register] : undefined,
  });
}

function createTerminatedAgeHistogram(register?: client.Registry): client.Histogram<string> {
  return new client.Histogram({
    name: "pg_long_transaction_age_seconds",
    help: "Age in seconds of a transaction at the moment its backend was terminated by the long-transaction reaper",
    buckets: [30, 45, 60, 90, 120, 180, 300, 600],
    registers: register ? [register] : undefined,
  });
}

/** Registers the reaper's metrics with `register`. Safe to call more than once. */
export function registerLongTransactionReaperMetrics(register: client.Registry): void {
  if (!terminatedTotal) terminatedTotal = createTerminatedCounter(register);
  if (!terminatedAgeSeconds) terminatedAgeSeconds = createTerminatedAgeHistogram(register);
}

/** @internal Exported for test isolation only. */
export function resetLongTransactionReaperMetrics(): void {
  terminatedTotal = undefined;
  terminatedAgeSeconds = undefined;
}

export interface LongTransactionReaperOptions extends Partial<LongTransactionReaperConfig> {
  logger?: (message: string) => void;
}

export class LongTransactionReaper {
  private readonly logger: (message: string) => void;
  private readonly config: LongTransactionReaperConfig;
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Queryable,
    options: LongTransactionReaperOptions = {},
  ) {
    const { logger, ...configOverrides } = options;
    this.logger = logger ?? (() => {});
    this.config = { ...DEFAULT_LONG_TRANSACTION_REAPER_CONFIG, ...configOverrides };
  }

  start(): void {
    if (this.interval) {
      this.logger("[LongTransactionReaper] Already running");
      return;
    }

    this.logger(
      `[LongTransactionReaper] Starting: terminating transactions older than ${this.config.maxTransactionAgeMs}ms, scanning every ${this.config.intervalMs}ms${
        this.config.dryRun ? " (dry-run)" : ""
      }`,
    );

    void this.run().catch((error) => {
      this.logger(
        `[LongTransactionReaper] Error in initial run: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    this.interval = setInterval(() => {
      void this.run().catch((error) => {
        this.logger(
          `[LongTransactionReaper] Error in scheduled run: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.logger("[LongTransactionReaper] Stopped");
    }
  }

  async run(): Promise<LongTransactionReaperResult> {
    if (this.running) {
      this.logger("[LongTransactionReaper] Already running, skipping this interval");
      return {
        scannedAt: new Date().toISOString(),
        durationMs: 0,
        candidateCount: 0,
        terminatedCount: 0,
        terminated: [],
        dryRun: this.config.dryRun,
      };
    }

    this.running = true;
    const startedAt = Date.now();
    const scannedAt = new Date().toISOString();
    const maxAgeSeconds = Math.max(1, Math.round(this.config.maxTransactionAgeMs / 1000));

    try {
      const query = this.config.dryRun ? SCAN_QUERY : TERMINATE_QUERY;
      const { rows } = await this.db.query<LongTransactionRow>(query, [maxAgeSeconds]);

      const terminated: TerminatedTransaction[] = rows.map((row) => ({
        pid: row.pid,
        usename: row.usename,
        applicationName: row.application_name,
        datname: row.datname,
        query: row.query,
        ageSeconds: typeof row.age_seconds === "string" ? Number(row.age_seconds) : row.age_seconds,
        terminated: this.config.dryRun ? false : Boolean(row.terminated),
      }));

      for (const txn of terminated) {
        this.logger(
          `[LongTransactionReaper] ${this.config.dryRun ? "[dry-run] would terminate" : "terminated"} backend pid=${txn.pid} ageSeconds=${Math.round(
            txn.ageSeconds,
          )} usename=${txn.usename ?? "?"} application=${txn.applicationName ?? "?"} datname=${txn.datname ?? "?"} query=${JSON.stringify(
            txn.query ?? "",
          )}`,
        );

        if (txn.terminated) {
          terminatedTotal?.inc();
          terminatedAgeSeconds?.observe(txn.ageSeconds);
        }
      }

      return {
        scannedAt,
        durationMs: Date.now() - startedAt,
        candidateCount: terminated.length,
        terminatedCount: terminated.filter((t) => t.terminated).length,
        terminated,
        dryRun: this.config.dryRun,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger(`[LongTransactionReaper] Error after ${Date.now() - startedAt}ms: ${message}`);
      throw new LongTransactionReaperError(`Long transaction reaper scan failed: ${message}`, { cause: error });
    } finally {
      this.running = false;
    }
  }
}

/** Convenience helper for one-off invocations (scripts, manual ops). */
export async function reapLongTransactions(
  db: Queryable,
  options: LongTransactionReaperOptions = {},
): Promise<LongTransactionReaperResult> {
  const reaper = new LongTransactionReaper(db, options);
  return reaper.run();
}
