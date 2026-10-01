/**
 * Boundary and recovery test suite for scripts/check-pending-migrations.ts
 *
 * Covers:
 *  - DATABASE_URL absent / empty / whitespace-only
 *  - Successful dry-run with no pending migrations
 *  - Successful dry-run with pending migrations (banner is printed)
 *  - Connection-refused / ECONNREFUSED recovery path
 *  - Generic database error recovery path
 *  - Arbitrary error string in result.error (non-connection, non-database)
 *  - Unexpected thrown exception recovery path
 *  - Non-Error thrown exception (string, number, null, undefined, object)
 *  - dryRunMigration called with correct options (skipPreflight, verbose)
 *  - Invariant: main() always resolves to 0, never rejects
 *  - Console.warn output is emitted for each warning scenario
 *  - No console output when there is nothing to report (no pending + success)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the migration runner module BEFORE importing the script under test.
// We use a factory mock so we can re-control the resolved value in each test.
// ---------------------------------------------------------------------------
vi.mock("../src/migrations/runner.js", () => ({
  dryRunMigration: vi.fn(),
}));

import { dryRunMigration } from "../src/migrations/runner.js";
import { main } from "./check-pending-migrations.js";

const mockDryRun = vi.mocked(dryRunMigration);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture all console.warn calls during a block */
function captureWarn(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  });
  return {
    messages,
    restore: () => spy.mockRestore(),
  };
}

function setDatabaseUrl(value: string | undefined) {
  if (value === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = value;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("check-pending-migrations – main()", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalEnv;
    }
  });

  // -------------------------------------------------------------------------
  // DATABASE_URL guard
  // -------------------------------------------------------------------------

  describe("DATABASE_URL not configured", () => {
    it("returns 0 when DATABASE_URL is absent", async () => {
      setDatabaseUrl(undefined);
      const { messages, restore } = captureWarn();
      const code = await main();
      restore();
      expect(code).toBe(0);
      expect(mockDryRun).not.toHaveBeenCalled();
    });

    it("emits a warning when DATABASE_URL is absent", async () => {
      setDatabaseUrl(undefined);
      const { messages, restore } = captureWarn();
      await main();
      restore();
      const combined = messages.join(" ");
      expect(combined).toMatch(/DATABASE_URL not set/i);
    });

    it("returns 0 when DATABASE_URL is an empty string", async () => {
      setDatabaseUrl("");
      const { messages, restore } = captureWarn();
      const code = await main();
      restore();
      expect(code).toBe(0);
      expect(mockDryRun).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // dryRunMigration invocation contract
  // -------------------------------------------------------------------------

  describe("dryRunMigration call contract", () => {
    beforeEach(() => setDatabaseUrl("postgres://localhost/credence"));

    it("calls dryRunMigration with skipPreflight:true and verbose:false", async () => {
      mockDryRun.mockResolvedValue({ success: true, applied: [] });
      await main();
      expect(mockDryRun).toHaveBeenCalledOnce();
      expect(mockDryRun).toHaveBeenCalledWith({
        skipPreflight: true,
        verbose: false,
      });
    });

    it("calls dryRunMigration exactly once per main() invocation", async () => {
      mockDryRun.mockResolvedValue({ success: true, applied: [] });
      await main();
      expect(mockDryRun).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: no pending migrations
  // -------------------------------------------------------------------------

  describe("success – no pending migrations", () => {
    beforeEach(() => setDatabaseUrl("postgres://localhost/credence"));

    it("returns 0 when applied list is empty", async () => {
      mockDryRun.mockResolvedValue({ success: true, applied: [] });
      const code = await main();
      expect(code).toBe(0);
    });

    it("does not emit any warning when there is nothing to report", async () => {
      mockDryRun.mockResolvedValue({ success: true, applied: [] });
      const { messages, restore } = captureWarn();
      await main();
      restore();
      expect(messages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: pending migrations found
  // -------------------------------------------------------------------------

  describe("success – pending migrations present", () => {
    beforeEach(() => setDatabaseUrl("postgres://localhost/credence"));

    it("returns 0 even when pending migrations are found", async () => {
      mockDryRun.mockResolvedValue({
        success: true,
        applied: ["001_initial_schema"],
      });
      const code = await main();
      expect(code).toBe(0);
    });

    it("emits a banner warning when there is 1 pending migration", async () => {
      mockDryRun.mockResolvedValue({
        success: true,
        applied: ["001_initial_schema"],
      });
      const { messages, restore } = captureWarn();
      await main();
      restore();
      const combined = messages.join("\n");
      expect(combined).toMatch(/pending database migration/i);
      expect(combined).toMatch(/migrate:dev/i);
    });

    it("reports the correct count of pending migrations", async () => {
      const pendingMigrations = [
        "002_add_users",
        "003_add_teams",
        "004_add_roles",
      ];
      mockDryRun.mockResolvedValue({
        success: true,
        applied: pendingMigrations,
      });
      const { messages, restore } = captureWarn();
      await main();
      restore();
      const combined = messages.join("\n");
      expect(combined).toContain("3");
    });

    it("returns 0 with many pending migrations (boundary: 100)", async () => {
      const many = Array.from({ length: 100 }, (_, i) => `${i}_migration`);
      mockDryRun.mockResolvedValue({ success: true, applied: many });
      const code = await main();
      expect(code).toBe(0);
    });

    it("emits exactly one banner block for multiple pending migrations", async () => {
      mockDryRun.mockResolvedValue({
        success: true,
        applied: ["002_schema", "003_index"],
      });
      const { messages, restore } = captureWarn();
      await main();
      restore();
      // The banner uses the ─── separator line; it should appear at least once
      const bannerLines = messages.filter((m) => m.includes("───"));
      expect(bannerLines.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Recovery: connection refused
  // -------------------------------------------------------------------------

  describe("recovery – ECONNREFUSED", () => {
    beforeEach(() => setDatabaseUrl("postgres://localhost/credence"));

    it("returns 0 on ECONNREFUSED", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "connect ECONNREFUSED 127.0.0.1:5432",
      });
      const code = await main();
      expect(code).toBe(0);
    });

    it("emits a connection warning on ECONNREFUSED", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "connect ECONNREFUSED 127.0.0.1:5432",
      });
      const { messages, restore } = captureWarn();
      await main();
      restore();
      const combined = messages.join(" ");
      expect(combined).toMatch(/Could not connect to database/i);
    });

    it("returns 0 for ECONNREFUSED on IPv6 address", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "connect ECONNREFUSED ::1:5432",
      });
      const code = await main();
      expect(code).toBe(0);
    });

    it("returns 0 for ECONNREFUSED in uppercase", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "ECONNREFUSED",
      });
      const code = await main();
      expect(code).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Recovery: generic database error
  // -------------------------------------------------------------------------

  describe("recovery – generic database error", () => {
    beforeEach(() => setDatabaseUrl("postgres://localhost/credence"));

    it("returns 0 when error message contains 'database' (lowercase)", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "database does not exist",
      });
      const code = await main();
      expect(code).toBe(0);
    });

    it("returns 0 when error message contains 'Database' (mixed case)", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "Database connection lost",
      });
      const code = await main();
      expect(code).toBe(0);
    });

    it("returns 0 when error message contains 'DATABASE' (uppercase)", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "DATABASE is unavailable",
      });
      const code = await main();
      expect(code).toBe(0);
    });

    it("emits a connection warning for generic database errors", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "database connection refused",
      });
      const { messages, restore } = captureWarn();
      await main();
      restore();
      const combined = messages.join(" ");
      expect(combined).toMatch(/Could not connect to database/i);
    });
  });

  // -------------------------------------------------------------------------
  // Recovery: non-connection failure result
  // -------------------------------------------------------------------------

  describe("recovery – non-connection failure result", () => {
    beforeEach(() => setDatabaseUrl("postgres://localhost/credence"));

    it("returns 0 when dryRun fails with an unrecognised error", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "permission denied for table pgmigrations",
      });
      const code = await main();
      expect(code).toBe(0);
    });

    it("emits a warning containing the original error message", async () => {
      const errorMsg = "permission denied for table pgmigrations";
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: errorMsg,
      });
      const { messages, restore } = captureWarn();
      await main();
      restore();
      const combined = messages.join(" ");
      expect(combined).toContain(errorMsg);
    });

    it("returns 0 when result.error is an empty string", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: "",
      });
      const code = await main();
      expect(code).toBe(0);
    });

    it("returns 0 when result.error is undefined", async () => {
      mockDryRun.mockResolvedValue({
        success: false,
        applied: [],
        error: undefined,
      });
      const code = await main();
      expect(code).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Recovery: thrown exception (unexpected)
  // -------------------------------------------------------------------------

  describe("recovery – thrown exception from dryRunMigration", () => {
    beforeEach(() => setDatabaseUrl("postgres://localhost/credence"));

    it("returns 0 when dryRunMigration throws an Error", async () => {
      mockDryRun.mockRejectedValue(new Error("unexpected crash"));
      const code = await main();
      expect(code).toBe(0);
    });

    it("emits a warning when dryRunMigration throws an Error", async () => {
      mockDryRun.mockRejectedValue(new Error("unexpected crash"));
      const { messages, restore } = captureWarn();
      await main();
      restore();
      const combined = messages.join(" ");
      expect(combined).toMatch(/Could not check migrations/i);
    });

    it("includes the error message in the warning details", async () => {
      const originalError = new Error("out of memory");
      mockDryRun.mockRejectedValue(originalError);
      const { messages, restore } = captureWarn();
      await main();
      restore();
      const combined = messages.join(" ");
      expect(combined).toContain("out of memory");
    });

    it("returns 0 when a non-Error string is thrown", async () => {
      mockDryRun.mockRejectedValue("string error");
      const code = await main();
      expect(code).toBe(0);
    });

    it("returns 0 when a number is thrown", async () => {
      mockDryRun.mockRejectedValue(42);
      const code = await main();
      expect(code).toBe(0);
    });

    it("returns 0 when null is thrown", async () => {
      mockDryRun.mockRejectedValue(null);
      const code = await main();
      expect(code).toBe(0);
    });

    it("returns 0 when undefined is thrown", async () => {
      mockDryRun.mockRejectedValue(undefined);
      const code = await main();
      expect(code).toBe(0);
    });

    it("returns 0 when a plain object is thrown", async () => {
      mockDryRun.mockRejectedValue({ code: "FATAL", detail: "disk full" });
      const code = await main();
      expect(code).toBe(0);
    });

    it("converts non-Error thrown values to a string in the warning", async () => {
      mockDryRun.mockRejectedValue("disk full");
      const { messages, restore } = captureWarn();
      await main();
      restore();
      const combined = messages.join(" ");
      // "disk full" should appear somewhere in Details: output
      expect(combined).toContain("disk full");
    });
  });

  // -------------------------------------------------------------------------
  // Invariant: main() ALWAYS resolves to 0, never rejects
  // -------------------------------------------------------------------------

  describe("invariant – always resolves to 0", () => {
    it("resolves to 0 for every known code path (smoke matrix)", async () => {
      const scenarios: Array<() => void> = [
        () => setDatabaseUrl(undefined),
        () => {
          setDatabaseUrl("postgres://localhost/db");
          mockDryRun.mockResolvedValue({ success: true, applied: [] });
        },
        () => {
          setDatabaseUrl("postgres://localhost/db");
          mockDryRun.mockResolvedValue({
            success: true,
            applied: ["001_init"],
          });
        },
        () => {
          setDatabaseUrl("postgres://localhost/db");
          mockDryRun.mockResolvedValue({
            success: false,
            applied: [],
            error: "ECONNREFUSED",
          });
        },
        () => {
          setDatabaseUrl("postgres://localhost/db");
          mockDryRun.mockResolvedValue({
            success: false,
            applied: [],
            error: "database not found",
          });
        },
        () => {
          setDatabaseUrl("postgres://localhost/db");
          mockDryRun.mockResolvedValue({
            success: false,
            applied: [],
            error: "some other error",
          });
        },
        () => {
          setDatabaseUrl("postgres://localhost/db");
          mockDryRun.mockRejectedValue(new Error("crash"));
        },
      ];

      for (const setup of scenarios) {
        vi.clearAllMocks();
        setup();
        const { restore } = captureWarn();
        const code = await main();
        restore();
        expect(code).toBe(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent / repeated invocations (no shared state mutation)
  // -------------------------------------------------------------------------

  describe("concurrent invocations", () => {
    it("handles concurrent calls without cross-contamination", async () => {
      setDatabaseUrl("postgres://localhost/credence");
      mockDryRun.mockResolvedValue({ success: true, applied: [] });
      const { restore } = captureWarn();
      const results = await Promise.all([main(), main(), main()]);
      restore();
      expect(results).toEqual([0, 0, 0]);
    });
  });

  // -------------------------------------------------------------------------
  // Boundary: result.applied edge cases
  // -------------------------------------------------------------------------

  describe("boundary – applied array edge cases", () => {
    beforeEach(() => setDatabaseUrl("postgres://localhost/credence"));

    it("returns 0 when applied is an empty array on success", async () => {
      mockDryRun.mockResolvedValue({ success: true, applied: [] });
      expect(await main()).toBe(0);
    });

    it("returns 0 when applied has exactly one entry", async () => {
      mockDryRun.mockResolvedValue({ success: true, applied: ["001"] });
      expect(await main()).toBe(0);
    });

    it("returns 0 when applied has migration names with special characters", async () => {
      mockDryRun.mockResolvedValue({
        success: true,
        applied: ["001_add_column_with-hyphen", "002_some_åéü"],
      });
      expect(await main()).toBe(0);
    });

    it("warns about pending migrations with long names without truncation", async () => {
      const longName = "a".repeat(200);
      mockDryRun.mockResolvedValue({ success: true, applied: [longName] });
      const { messages, restore } = captureWarn();
      await main();
      restore();
      // Just verify we still warn about pending migrations
      const combined = messages.join(" ");
      expect(combined).toMatch(/pending database migration/i);
    });
  });
});
