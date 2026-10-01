import { describe, expect, it, vi } from "vitest";
import {
  PgStatActivitySnapshotJob,
  snapshotPgStatActivity,
} from "./pgStatActivitySnapshotJob.js";

describe("PgStatActivitySnapshotJob", () => {
  it("captures a pg_stat_activity snapshot and prunes rows older than 24 hours", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            pid: 123,
            usename: "app",
            datname: "credence",
            state: "active",
            query: "SELECT 1",
            backend_type: "client backend",
            application_name: "credence-api",
            client_addr: "127.0.0.1",
            wait_event_type: null,
            wait_event: null,
            backend_start: "2026-07-24T00:00:00.000Z",
            xact_start: "2026-07-24T00:00:01.000Z",
            query_start: "2026-07-24T00:00:02.000Z",
            state_change: "2026-07-24T00:00:03.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const job = new PgStatActivitySnapshotJob({ query } as any, {
      logger: vi.fn(),
    });
    const result = await job.run();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain(
      "INSERT INTO pg_stat_activity_snapshots",
    );
    expect(query.mock.calls[1][0]).toContain(
      "DELETE FROM pg_stat_activity_snapshots",
    );
    expect(query.mock.calls[0][0]).toContain(
      "ON CONFLICT (snapshot_at, pid) DO NOTHING",
    );
    expect(query.mock.calls[1][1]).toEqual([24]);
    expect(result.rowsInserted).toBe(1);
    expect(result.rowsDeleted).toBe(0);
  });

  it.each([0, -1, 1.5, Infinity, 2_147_483_648])(
    "rejects an invalid timer interval (%s)",
    (intervalMs) => {
      expect(
        () =>
          new PgStatActivitySnapshotJob({ query: vi.fn() } as any, {
            intervalMs,
          }),
      ).toThrow(RangeError);
    },
  );

  it.each([0, -1, NaN, Infinity])(
    "rejects an invalid retention window (%s)",
    (retentionHours) => {
      expect(
        () =>
          new PgStatActivitySnapshotJob({ query: vi.fn() } as any, {
            retentionHours,
          }),
      ).toThrow(RangeError);
    },
  );

  it("accepts the smallest and largest supported timer intervals", () => {
    expect(
      () =>
        new PgStatActivitySnapshotJob({ query: vi.fn() } as any, {
          intervalMs: 1,
        }),
    ).not.toThrow();
    expect(
      () =>
        new PgStatActivitySnapshotJob({ query: vi.fn() } as any, {
          intervalMs: 2_147_483_647,
        }),
    ).not.toThrow();
  });

  it("skips an overlapping run without issuing another query", async () => {
    let resolveInsert!: (result: { rows: never[]; rowCount: number }) => void;
    const query = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInsert = resolve;
          }),
      )
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const job = new PgStatActivitySnapshotJob({ query } as any);

    const firstRun = job.run();
    const skippedRun = await job.run();

    expect(query).toHaveBeenCalledTimes(1);
    expect(skippedRun).toMatchObject({
      rowsInserted: 0,
      rowsDeleted: 0,
      durationMs: 0,
    });
    expect(Number.isNaN(Date.parse(skippedRun.snapshotAt))).toBe(false);

    resolveInsert({ rows: [], rowCount: 0 });
    await firstRun;
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("releases the run guard after an insert failure so a later run can recover", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const job = new PgStatActivitySnapshotJob({ query } as any);

    await expect(job.run()).rejects.toThrow("insert failed");
    const recovered = await job.run();

    expect(recovered.rowsInserted).toBe(0);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("retries cleanup after a partial failure without wedging later snapshots", async () => {
    const logger = vi.fn();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 });
    const job = new PgStatActivitySnapshotJob({ query } as any, { logger });

    await expect(job.run()).rejects.toThrow("cleanup failed");
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("cleanup failed"),
    );

    const recovered = await job.run();

    expect(recovered).toMatchObject({ rowsInserted: 1, rowsDeleted: 3 });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("treats a null database row count as zero", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const job = new PgStatActivitySnapshotJob({ query } as any);

    await expect(job.run()).resolves.toMatchObject({
      rowsInserted: 0,
      rowsDeleted: 0,
    });
  });

  it("exposes a standalone snapshot helper", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await snapshotPgStatActivity({ query } as any);
    expect(result.rowsInserted).toBe(0);
  });
});
