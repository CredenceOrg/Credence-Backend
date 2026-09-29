/**
 * Boundary + recovery coverage for scripts/sbom-validate.ts.
 *
 * Maps to issues #1328 acceptance criteria:
 * - deterministic for valid/invalid/duplicate/boundary inputs
 * - validation invariants enforced (fail-closed, typed errors)
 * - retries/partial failure/concurrent execution are safe (pure function)
 * - success/rejection/boundary/regression scenarios
 * - callers remain compatible (validateSbom/validateSbomFile/runCli shapes unchanged)
 * - failures diagnosable without exposing sensitive data (path + reason only)
 *
 * Recovery states covered: missing file, invalid JSON, schema mismatch, empty
 * inventory, unreadable path (directory), retry-after-fix, concurrent validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSbom,
  validateSbomFile,
  runCli,
} from "./sbom-validate.js";

function validSbom(overrides: Record<string, unknown> = {}) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    components: [{ type: "library", name: "zod", version: "4.3.6" }],
    ...overrides,
  };
}

describe("sbom-validate boundary + recovery", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sbom-test-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("success paths (deterministic)", () => {
    it("accepts minimal valid SBOM with a single component", () => {
      const r = validateSbom(validSbom());
      expect(r).toEqual({ ok: true, specVersion: "1.5", componentCount: 1 });
    });

    it("accepts components with only required name field", () => {
      const r = validateSbom(
        validSbom({ components: [{ name: "x" }] }),
      );
      expect(r.ok).toBe(true);
    });

    it("is deterministic for the same input across repeated calls", () => {
      const input = validSbom({
        components: [
          { name: "a", version: "1.0.0" },
          { name: "b" },
        ],
      });
      const first = validateSbom(input);
      const second = validateSbom(structuredClone(input));
      expect(second).toEqual(first);
    });

    it("does not mutate its input", () => {
      const input = validSbom();
      const snapshot = JSON.stringify(input);
      validateSbom(input);
      expect(JSON.stringify(input)).toBe(snapshot);
    });

    it("ignores unknown extra fields (forward-compatible)", () => {
      const r = validateSbom(
        validSbom({
          metadata: { timestamp: "2026-01-01" },
          components: [{ name: "a", extra: "kept" }],
        } as unknown as Record<string, unknown>),
      );
      expect(r.ok).toBe(true);
    });

    it("counts duplicate components deterministically (no dedup)", () => {
      const dup = { name: "dup", version: "1.0.0" };
      const r = validateSbom(
        validSbom({ components: [dup, { ...dup }, { ...dup }] }),
      );
      expect(r).toEqual({ ok: true, specVersion: "1.5", componentCount: 3 });
    });
  });

  describe("rejection paths (fail-closed, typed)", () => {
    it.each([null, undefined, "", "string", 42, [], true])(
      "rejects non-object root %p with SCHEMA_MISMATCH",
      (raw) => {
        const r = validateSbom(raw);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("SCHEMA_MISMATCH");
      },
    );

    it("rejects missing bomFormat", () => {
      const r = validateSbom({ specVersion: "1.5", components: [{ name: "a" }] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("SCHEMA_MISMATCH");
    });

    it.each(["cyclonedx", "CycloneDx", "", "SPDX"])(
      "rejects wrong bomFormat %p",
      (bomFormat) => {
        const r = validateSbom(
          validSbom({ bomFormat, components: [{ name: "a" }] }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("SCHEMA_MISMATCH");
      },
    );

    it.each([undefined, "", [], {}, 42, null])(
      "rejects invalid specVersion %p",
      (specVersion) => {
        const r = validateSbom(
          validSbom({ specVersion, components: [{ name: "a" }] } as unknown as Record<string, unknown>),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("SCHEMA_MISMATCH");
      },
    );

    it("rejects single-char specVersion boundary only when empty", () => {
      // "1" is the smallest valid specVersion (min length 1).
      expect(validateSbom(validSbom({ specVersion: "1", components: [{ name: "a" }] })).ok).toBe(true);
      const empty = validateSbom(validSbom({ specVersion: "", components: [{ name: "a" }] }));
      expect(empty.ok).toBe(false);
    });

    it.each([undefined, null, {}, "x", 42])(
      "rejects non-array components %p",
      (components) => {
        const r = validateSbom(
          validSbom({ components } as unknown as Record<string, unknown>),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("SCHEMA_MISMATCH");
      },
    );

    it("rejects empty components with EMPTY_COMPONENTS (not schema mismatch)", () => {
      const r = validateSbom(validSbom({ components: [] }));
      expect(r).toMatchObject({ ok: false, code: "EMPTY_COMPONENTS" });
    });

    it.each([
      [{ version: "1.0.0" }],
      [{ name: "" }],
      [{ name: 42 }],
      [{ name: null }],
      ["string-component"],
      [null],
      [42],
    ])("rejects malformed component entry %p", (components) => {
      const r = validateSbom(validSbom({ components } as unknown as Record<string, unknown>));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("SCHEMA_MISMATCH");
    });

    it("error message is diagnosable and names the offending path", () => {
      const r = validateSbom({ specVersion: "1.5", components: [] });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message.length).toBeGreaterThan(10);
        // Must not echo arbitrary payload contents verbatim beyond path/reason.
        expect(r.message).toContain("bomFormat");
      }
    });
  });

  describe("boundary cases", () => {
    it("0 components fails, 1 component passes", () => {
      expect(validateSbom(validSbom({ components: [] })).ok).toBe(false);
      expect(
        validateSbom(validSbom({ components: [{ name: "only" }] })).ok,
      ).toBe(true);
    });

    it("handles 1-char component name, rejects empty name", () => {
      expect(
        validateSbom(validSbom({ components: [{ name: "a" }] })).ok,
      ).toBe(true);
      const r = validateSbom(validSbom({ components: [{ name: "" }] }));
      expect(r.ok).toBe(false);
    });

    it("handles large inventories deterministically (5000 components)", () => {
      const components = Array.from({ length: 5000 }, (_, i) => ({
        name: `pkg-${i}`,
        version: "1.0.0",
      }));
      const r = validateSbom(validSbom({ components }));
      expect(r).toEqual({ ok: true, specVersion: "1.5", componentCount: 5000 });
      // Duplicate run yields identical result (no timing/state dependence).
      expect(validateSbom(validSbom({ components }))).toEqual(r);
    });

    it("handles unicode and long names", () => {
      const longName = "a".repeat(1024);
      const r = validateSbom(
        validSbom({ components: [{ name: longName }, { name: "päckågé-🚀" }] }),
      );
      expect(r).toEqual({ ok: true, specVersion: "1.5", componentCount: 2 });
    });

    it("handles very long specVersion", () => {
      const r = validateSbom(
        validSbom({ specVersion: "1.".padEnd(512, "0") }),
      );
      expect(r.ok).toBe(true);
    });
  });

  describe("file recovery (loading / error / retry / permission / stale)", () => {
    it("validates a real file on disk", () => {
      const p = join(dir, "sbom.json");
      writeFileSync(p, JSON.stringify(validSbom({ components: [{ name: "a" }, { name: "b" }] })));
      const r = validateSbomFile(p);
      expect(r).toEqual({ ok: true, specVersion: "1.5", componentCount: 2 });
    });

    it("returns INVALID_JSON for a missing file without throwing", () => {
      const p = join(dir, "does-not-exist.json");
      const r = validateSbomFile(p);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("INVALID_JSON");
        expect(r.message).toContain(p);
        expect(r.message).toMatch(/ENOENT|Unable to read/i);
      }
    });

    it("returns INVALID_JSON for invalid JSON without throwing", () => {
      const p = join(dir, "bad.json");
      writeFileSync(p, "{ not json,,,");
      const r = validateSbomFile(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("INVALID_JSON");
    });

    it("returns INVALID_JSON for an empty file", () => {
      const p = join(dir, "empty.json");
      writeFileSync(p, "");
      expect(validateSbomFile(p)).toMatchObject({ ok: false, code: "INVALID_JSON" });
    });

    it("returns INVALID_JSON for a directory path", () => {
      const r = validateSbomFile(dir);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("INVALID_JSON");
    });

    it("surfaces schema failures from files as typed results", () => {
      const p = join(dir, "empty-components.json");
      writeFileSync(p, JSON.stringify(validSbom({ components: [] })));
      expect(validateSbomFile(p)).toMatchObject({ ok: false, code: "EMPTY_COMPONENTS" });

      const p2 = join(dir, "wrong-format.json");
      writeFileSync(p2, JSON.stringify({ bomFormat: "SPDX", specVersion: "1", components: [{ name: "a" }] }));
      expect(validateSbomFile(p2)).toMatchObject({ ok: false, code: "SCHEMA_MISMATCH" });
    });

    it("does not leak file contents in error messages", () => {
      const secret = "SECRET-abc-123-xyz";
      const p = join(dir, "secret.json");
      writeFileSync(p, "{ invalid json with " + secret);
      const r = validateSbomFile(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).not.toContain(secret);
    });

    it("supports retry: failure then success after the file is fixed", () => {
      const p = join(dir, "retry.json");
      writeFileSync(p, "broken");
      expect(validateSbomFile(p).ok).toBe(false);
      writeFileSync(p, JSON.stringify(validSbom()));
      const retry = validateSbomFile(p);
      expect(retry.ok).toBe(true);
    });

    it("has no stale cache: sequential validations reflect current file contents", () => {
      const p = join(dir, "stale.json");
      writeFileSync(p, JSON.stringify(validSbom({ specVersion: "1.5" })));
      expect(validateSbomFile(p).ok).toBe(true);
      writeFileSync(p, JSON.stringify(validSbom({ components: [] })));
      const second = validateSbomFile(p);
      expect(second).toMatchObject({ ok: false, code: "EMPTY_COMPONENTS" });
    });

    it("is safe for concurrent validation (Promise.all, no shared state)", async () => {
      const inputs = Array.from({ length: 20 }, (_, i) =>
        validSbom({ components: [{ name: `pkg-${i}` }] }),
      );
      const results = await Promise.all(
        inputs.map(async (input) => validateSbom(input)),
      );
      for (const r of results) {
        expect(r).toEqual({ ok: true, specVersion: "1.5", componentCount: 1 });
      }
    });
  });

  describe("runCli (user-visible errors + exit codes)", () => {
    it("returns 0 and logs OK for a valid file", () => {
      const p = join(dir, "ok.json");
      writeFileSync(p, JSON.stringify(validSbom()));
      const code = runCli([p]);
      expect(code).toBe(0);
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining("OK"),
      );
      expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    });

    it("returns 1 and logs typed error for an invalid file", () => {
      const p = join(dir, "missing.json");
      const code = runCli([p]);
      expect(code).toBe(1);
      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        expect.stringContaining("INVALID_JSON"),
      );
    });

    it("returns 1 for empty inventory and surfaces EMPTY_COMPONENTS", () => {
      const p = join(dir, "empty.json");
      writeFileSync(p, JSON.stringify(validSbom({ components: [] })));
      expect(runCli([p])).toBe(1);
      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        expect.stringContaining("EMPTY_COMPONENTS"),
      );
    });

    it("is retry-safe: same argv yields same exit code deterministically", () => {
      const p = join(dir, "retry-cli.json");
      writeFileSync(p, JSON.stringify(validSbom()));
      expect(runCli([p])).toBe(0);
      expect(runCli([p])).toBe(0);
      expect(runCli([join(dir, "nope.json")])).toBe(1);
      expect(runCli([join(dir, "nope.json")])).toBe(1);
    });
  });
});
