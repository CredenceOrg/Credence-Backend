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
    expect(result.rowsInserted).toBe(1);
    expect(result.rowsDeleted).toBe(0);
  });

  it("exposes a standalone snapshot helper", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await snapshotPgStatActivity({ query } as any);
    expect(result.rowsInserted).toBe(0);
  });
});
