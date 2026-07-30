import type { Queryable } from "../db/repositories/queryable.js";
import {
  PG_STAT_ACTIVITY_SNAPSHOT_RETENTION_HOURS,
  PG_STAT_ACTIVITY_SNAPSHOT_INTERVAL_MS,
} from "../config/constants.js";

export interface PgStatActivitySnapshotJobConfig {
  logger?: (message: string) => void;
  intervalMs?: number;
  retentionHours?: number;
}

export interface PgStatActivitySnapshotResult {
  rowsInserted: number;
  rowsDeleted: number;
  durationMs: number;
  snapshotAt: string;
}

interface PgStatActivityRow {
  pid: number;
  usename: string | null;
  datname: string | null;
  state: string | null;
  query: string | null;
  backend_type: string | null;
  application_name: string | null;
  client_addr: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  backend_start: string | null;
  xact_start: string | null;
  query_start: string | null;
  state_change: string | null;
}

const PG_STAT_ACTIVITY_SNAPSHOT_TABLE = "pg_stat_activity_snapshots";

export class PgStatActivitySnapshotJob {
  private readonly logger: (message: string) => void;
  private readonly intervalMs: number;
  private readonly retentionHours: number;
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Queryable,
    config: PgStatActivitySnapshotJobConfig = {},
  ) {
    this.logger = config.logger ?? (() => {});
    this.intervalMs =
      config.intervalMs ?? PG_STAT_ACTIVITY_SNAPSHOT_INTERVAL_MS;
    this.retentionHours =
      config.retentionHours ?? PG_STAT_ACTIVITY_SNAPSHOT_RETENTION_HOURS;
  }

  start(): void {
    if (this.interval) {
      this.logger("[PgStatActivitySnapshotJob] Already running");
      return;
    }

    this.logger(
      `[PgStatActivitySnapshotJob] Starting periodic snapshot every ${this.intervalMs}ms`,
    );

    void this.run().catch((error) => {
      this.logger(
        `[PgStatActivitySnapshotJob] Error in initial run: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    this.interval = setInterval(() => {
      void this.run().catch((error) => {
        this.logger(
          `[PgStatActivitySnapshotJob] Error in scheduled run: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.logger("[PgStatActivitySnapshotJob] Stopped");
    }
  }

  async run(): Promise<PgStatActivitySnapshotResult> {
    if (this.running) {
      this.logger(
        "[PgStatActivitySnapshotJob] Already running, skipping this interval",
      );
      return {
        rowsInserted: 0,
        rowsDeleted: 0,
        durationMs: 0,
        snapshotAt: new Date().toISOString(),
      };
    }

    this.running = true;
    const startedAt = Date.now();
    const snapshotAt = new Date().toISOString();

    try {
      const insertResult = await this.db.query(
        `
          INSERT INTO ${PG_STAT_ACTIVITY_SNAPSHOT_TABLE} (
            snapshot_at,
            pid,
            usename,
            datname,
            state,
            query,
            backend_type,
            application_name,
            client_addr,
            wait_event_type,
            wait_event,
            backend_start,
            xact_start,
            query_start,
            state_change
          )
          SELECT
            $1::timestamptz,
            pid,
            usename,
            datname,
            state,
            query,
            backend_type,
            application_name,
            client_addr,
            wait_event_type,
            wait_event,
            backend_start,
            xact_start,
            query_start,
            state_change
          FROM pg_stat_activity
          ON CONFLICT (snapshot_at, pid) DO NOTHING
        `,
        [snapshotAt],
      );

      const deleteResult = await this.db.query(
        `
          DELETE FROM ${PG_STAT_ACTIVITY_SNAPSHOT_TABLE}
          WHERE snapshot_at < NOW() - interval '1 hour' * $1
        `,
        [this.retentionHours],
      );

      const durationMs = Date.now() - startedAt;
      const rowsInserted = insertResult.rowCount ?? 0;
      const rowsDeleted = deleteResult.rowCount ?? 0;

      this.logger(
        `[PgStatActivitySnapshotJob] Completed: inserted=${rowsInserted} deleted=${rowsDeleted} duration=${durationMs}ms`,
      );

      return {
        rowsInserted,
        rowsDeleted,
        durationMs,
        snapshotAt,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.logger(
        `[PgStatActivitySnapshotJob] Error after ${durationMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      this.running = false;
    }
  }
}

export async function snapshotPgStatActivity(
  db: Queryable,
  config: Omit<PgStatActivitySnapshotJobConfig, "intervalMs"> = {},
): Promise<PgStatActivitySnapshotResult> {
  const job = new PgStatActivitySnapshotJob(db, config);
  return job.run();
}
