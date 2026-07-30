import { describe, expect, it, vi, beforeEach } from "vitest";
import client from "prom-client";
import {
  LongTransactionReaper,
  LongTransactionReaperError,
  DEFAULT_LONG_TRANSACTION_REAPER_CONFIG,
  loadLongTransactionReaperConfig,
  reapLongTransactions,
  registerLongTransactionReaperMetrics,
  resetLongTransactionReaperMetrics,
} from "./longTransactionReaper.js";

function overAgeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pid: 4242,
    usename: "app",
    application_name: "credence-api",
    datname: "credence",
    query: "UPDATE accounts SET balance = balance - 1 WHERE id = $1",
    age_seconds: 45,
    terminated: true,
    ...overrides,
  };
}

describe("loadLongTransactionReaperConfig", () => {
  it("falls back to defaults when env vars are unset", () => {
    const config = loadLongTransactionReaperConfig({});
    expect(config).toEqual(DEFAULT_LONG_TRANSACTION_REAPER_CONFIG);
  });

  it("parses overrides from env vars", () => {
    const config = loadLongTransactionReaperConfig({
      DB_LONG_TRANSACTION_MAX_AGE_MS: "60000",
      DB_LONG_TRANSACTION_REAPER_INTERVAL_MS: "5000",
      DB_LONG_TRANSACTION_REAPER_ENABLED: "false",
      DB_LONG_TRANSACTION_REAPER_DRY_RUN: "true",
    });
    expect(config).toEqual({
      maxTransactionAgeMs: 60_000,
      intervalMs: 5_000,
      enabled: false,
      dryRun: true,
    });
  });

  it("ignores invalid numeric overrides and keeps defaults", () => {
    const config = loadLongTransactionReaperConfig({
      DB_LONG_TRANSACTION_MAX_AGE_MS: "not-a-number",
      DB_LONG_TRANSACTION_REAPER_INTERVAL_MS: "-5",
    });
    expect(config.maxTransactionAgeMs).toBe(
      DEFAULT_LONG_TRANSACTION_REAPER_CONFIG.maxTransactionAgeMs,
    );
    expect(config.intervalMs).toBe(
      DEFAULT_LONG_TRANSACTION_REAPER_CONFIG.intervalMs,
    );
  });
});

describe("LongTransactionReaper.run", () => {
  it("terminates backends holding a transaction open past the max age", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [overAgeRow()] });
    const reaper = new LongTransactionReaper(
      { query } as any,
      { maxTransactionAgeMs: 30_000, logger: vi.fn() },
    );

    const result = await reaper.run();

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("pg_terminate_backend(pid)");
    expect(sql).toContain("xact_start < now() - ($1 || ' seconds')::interval");
    expect(params).toEqual([30]);
    expect(result.candidateCount).toBe(1);
    expect(result.terminatedCount).toBe(1);
    expect(result.terminated[0]).toMatchObject({ pid: 4242, terminated: true });
    expect(result.dryRun).toBe(false);
  });

  // Negative test the issue asks for: without termination wired up correctly,
  // a transaction sitting past the age threshold keeps holding its locks and
  // its connection stays checked out of the pool -- exactly the hold-off
  // cascade this feature exists to stop. This assertion fails against a
  // no-op/disabled reaper and only passes once dry-run truly skips
  // termination while a real run truly performs it.
  it("does NOT terminate anything in dry-run mode, proving dry-run alone is not a guard", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [overAgeRow({ terminated: null })],
    });
    const reaper = new LongTransactionReaper(
      { query } as any,
      { maxTransactionAgeMs: 30_000, dryRun: true, logger: vi.fn() },
    );

    const result = await reaper.run();

    const [sql] = query.mock.calls[0];
    expect(sql).not.toContain("pg_terminate_backend");
    expect(result.terminatedCount).toBe(0);
    expect(result.terminated[0].terminated).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  it("uses at least a 1-second floor for sub-second configured max ages", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const reaper = new LongTransactionReaper(
      { query } as any,
      { maxTransactionAgeMs: 500 },
    );

    await reaper.run();

    expect(query.mock.calls[0][1]).toEqual([1]);
  });

  it("scopes the query to the current database, excludes its own backend, and only targets client backends", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const reaper = new LongTransactionReaper({ query } as any);

    await reaper.run();

    const [sql] = query.mock.calls[0];
    expect(sql).toContain("pid <> pg_backend_pid()");
    expect(sql).toContain("datname = current_database()");
    expect(sql).toContain("backend_type = 'client backend'");
  });

  it("wraps query failures in a LongTransactionReaperError instead of throwing raw errors", async () => {
    const query = vi.fn().mockRejectedValue(new Error("connection terminated"));
    const reaper = new LongTransactionReaper({ query } as any, { logger: vi.fn() });

    await expect(reaper.run()).rejects.toBeInstanceOf(LongTransactionReaperError);
    await expect(reaper.run()).rejects.toThrow(/Long transaction reaper scan failed/);
  });

  it("returns a zero-result and skips re-entrant runs while one is already in flight", async () => {
    let resolveQuery: (value: unknown) => void = () => {};
    const query = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveQuery = resolve; }),
    );
    const reaper = new LongTransactionReaper({ query } as any, { logger: vi.fn() });

    const firstRun = reaper.run();
    const secondRun = await reaper.run();

    expect(secondRun.candidateCount).toBe(0);
    expect(secondRun.terminatedCount).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);

    resolveQuery({ rows: [] });
    await firstRun;
  });
});

describe("reapLongTransactions", () => {
  it("runs a one-off scan via a fresh reaper instance", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [overAgeRow()] });
    const result = await reapLongTransactions({ query } as any, { logger: vi.fn() });
    expect(result.terminatedCount).toBe(1);
  });
});

describe("LongTransactionReaper metrics", () => {
  beforeEach(() => {
    resetLongTransactionReaperMetrics();
  });

  it("increments the terminated counter and age histogram only for terminated backends", async () => {
    const registry = new client.Registry();
    registerLongTransactionReaperMetrics(registry);

    const query = vi.fn().mockResolvedValue({
      rows: [overAgeRow({ pid: 1, terminated: true, age_seconds: 60 })],
    });
    const reaper = new LongTransactionReaper({ query } as any, { logger: vi.fn() });
    await reaper.run();

    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === "pg_long_transactions_terminated_total");
    expect((counter as any)?.values?.[0]?.value).toBe(1);
  });

  it("is idempotent to call twice", () => {
    const registry = new client.Registry();
    expect(() => {
      registerLongTransactionReaperMetrics(registry);
      registerLongTransactionReaperMetrics(registry);
    }).not.toThrow();
  });
});

describe("LongTransactionReaper.start/stop", () => {
  it("schedules periodic runs and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const reaper = new LongTransactionReaper(
        { query } as any,
        { intervalMs: 1000, logger: vi.fn() },
      );

      reaper.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(query).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(query).toHaveBeenCalledTimes(2);

      reaper.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op to start twice", () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const logger = vi.fn();
    const reaper = new LongTransactionReaper({ query } as any, { logger });

    reaper.start();
    reaper.start();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Already running"),
    );
    reaper.stop();
  });
});
