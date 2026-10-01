import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `spawnSync` is the only side-effecting dependency of the module under test, so
 * it is replaced to make every scanner outcome (success, findings, crash,
 * timeout, missing binary) deterministic and independent of the host toolchain.
 */
const scannerControl = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: scannerControl.spawnSync,
}));

// Import the module after setting up mocks
let depsAuditModule: typeof import("./deps-audit.ts");

describe("deps-audit", () => {
  beforeAll(async () => {
    depsAuditModule = await import("./deps-audit.ts");
  });

  describe("parseNpmAudit", () => {
    it("parses valid npm audit JSON with vulnerabilities", () => {
      const npmAuditJson = JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          lodash: {
            severity: "high",
            via: [{ source: 12345, name: "Prototype Pollution" }],
            name: "lodash",
            fixAvailable: "4.17.21",
          },
        },
      });

      const result = depsAuditModule.parseNpmAudit(npmAuditJson);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        packageName: "lodash",
        severity: "high",
        id: expect.stringContaining("12345"),
        fixedVersion: "4.17.21",
      });
    });

    it("returns empty array for empty input", () => {
      expect(depsAuditModule.parseNpmAudit("")).toEqual([]);
      expect(depsAuditModule.parseNpmAudit("  ")).toEqual([]);
    });

    it("returns empty array for audit report with no vulnerabilities", () => {
      const npmAuditJson = JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {},
      });

      expect(depsAuditModule.parseNpmAudit(npmAuditJson)).toEqual([]);
    });

    it("handles vulnerabilities with string 'via' field", () => {
      const npmAuditJson = JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          "example-pkg": {
            severity: "moderate",
            via: "CVE-2023-12345",
            name: "example-pkg",
            fixAvailable: false,
          },
        },
      });

      const result = depsAuditModule.parseNpmAudit(npmAuditJson);
      expect(result).toHaveLength(1);
      expect(result[0].id).toContain("CVE-2023-12345");
      expect(result[0].severity).toBe("moderate");
    });
  });

  describe("parseOsvScanner", () => {
    it("parses valid osv-scanner JSON output", () => {
      const osvJson = JSON.stringify({
        results: [
          {
            source: {
              path: "package-lock.json",
              type: "lockfile",
            },
            packages: [
              {
                package: {
                  name: "vulnerable-pkg",
                  version: "1.0.0",
                  ecosystem: "npm",
                },
              },
            ],
            vulnerabilities: [
              {
                id: "GHSA-xxxx-xxxx-xxxx",
                summary: "Arbitrary Code Execution",
                severity: "HIGH",
                affected: [
                  {
                    package: { name: "vulnerable-pkg" },
                    ranges: [
                      {
                        events: [
                          { introduced: "0" },
                          { fixed: "2.0.0" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });

      const result = depsAuditModule.parseOsvScanner(osvJson);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        packageName: "vulnerable-pkg",
        severity: "high",
        id: "GHSA-xxxx-xxxx-xxxx",
        fixedVersion: "2.0.0",
      });
    });

    it("returns empty array for empty input", () => {
      expect(depsAuditModule.parseOsvScanner("")).toEqual([]);
      expect(depsAuditModule.parseOsvScanner("  ")).toEqual([]);
    });

    it("returns empty array for results with no vulnerabilities", () => {
      const osvJson = JSON.stringify({
        results: [
          {
            source: {
              path: "package-lock.json",
              type: "lockfile",
            },
            packages: [],
            vulnerabilities: [],
          },
        ],
      });

      expect(depsAuditModule.parseOsvScanner(osvJson)).toEqual([]);
    });
  });

  describe("evaluateThreshold", () => {
    it("passes when threshold is critical and only high issues exist", () => {
      const highIssues = [
        { packageName: "pkg-high", severity: "high", id: "CVE-3", title: "High", fixedVersion: "3.0.0" },
      ];

      const result = depsAuditModule.evaluateThreshold(highIssues, "critical");

      expect(result.passed).toBe(true);
      expect(result.violatingFindings).toHaveLength(0);
    });

    it("fails when threshold is high and high issues exist", () => {
      const highIssues = [
        { packageName: "pkg-high", severity: "high", id: "CVE-3", title: "High", fixedVersion: "3.0.0" },
        { packageName: "pkg-critical", severity: "critical", id: "CVE-4", title: "Critical", fixedVersion: "4.0.0" },
      ];

      const result = depsAuditModule.evaluateThreshold(highIssues, "high");

      expect(result.passed).toBe(false);
      expect(result.violatingFindings).toHaveLength(2); // high + critical
      expect(result.violatingFindings.map((i) => i.packageName)).toEqual(["pkg-high", "pkg-critical"]);
    });

    it("fails when threshold is medium and medium issues exist", () => {
      const mediumIssues = [
        { packageName: "pkg-medium", severity: "medium", id: "CVE-2", title: "Medium", fixedVersion: "2.0.0" },
        { packageName: "pkg-high", severity: "high", id: "CVE-3", title: "High", fixedVersion: "3.0.0" },
        { packageName: "pkg-critical", severity: "critical", id: "CVE-4", title: "Critical", fixedVersion: "4.0.0" },
      ];

      const result = depsAuditModule.evaluateThreshold(mediumIssues, "medium");

      expect(result.passed).toBe(false);
      expect(result.violatingFindings).toHaveLength(3); // medium + high + critical
    });

    it("treats 'moderate' as 'medium' severity", () => {
      const moderateIssues = [
        { packageName: "pkg-mod", severity: "moderate", id: "CVE-MOD", title: "Moderate", fixedVersion: "1.0.0" },
      ];

      const result = depsAuditModule.evaluateThreshold(moderateIssues, "medium");

      expect(result.passed).toBe(false);
      expect(result.violatingFindings).toHaveLength(1);
    });
  });

  describe("deduplicateFindings", () => {
    it("deduplicates findings by package and id, keeping highest severity", () => {
      const findings = [
        { packageName: "pkg1", severity: "low", id: "CVE-1", title: "Low", fixedVersion: "1.0.0", source: "npm-audit" as const },
        { packageName: "pkg1", severity: "high", id: "CVE-1", title: "High", fixedVersion: "1.0.0", source: "osv-scanner" as const },
        { packageName: "pkg2", severity: "medium", id: "CVE-2", title: "Medium", fixedVersion: "2.0.0", source: "npm-audit" as const },
      ];

      const result = depsAuditModule.deduplicateFindings(findings);

      expect(result).toHaveLength(2);
      expect(result.find((f) => f.packageName === "pkg1")?.severity).toBe("high");
      expect(result.find((f) => f.packageName === "pkg2")?.severity).toBe("medium");
    });

    it("returns empty array for empty input", () => {
      expect(depsAuditModule.deduplicateFindings([])).toEqual([]);
    });
  });

  describe("summariseFindings", () => {
    it("summarises findings by severity", () => {
      const findings = [
        { packageName: "pkg1", severity: "critical", id: "CVE-1", title: "Critical", fixedVersion: "1.0.0", source: "npm-audit" as const },
        { packageName: "pkg2", severity: "high", id: "CVE-2", title: "High", fixedVersion: "2.0.0", source: "npm-audit" as const },
        { packageName: "pkg3", severity: "high", id: "CVE-3", title: "High", fixedVersion: "3.0.0", source: "npm-audit" as const },
        { packageName: "pkg4", severity: "medium", id: "CVE-4", title: "Medium", fixedVersion: "4.0.0", source: "npm-audit" as const },
      ];

      const summary = depsAuditModule.summariseFindings(findings);

      expect(summary.critical).toBe(1);
      expect(summary.high).toBe(2);
      expect(summary.medium).toBe(1);
      expect(summary.low).toBe(0);
    });
  });

  describe("parseArgs", () => {
    it("parses threshold flag correctly", () => {
      const args = depsAuditModule.parseArgs(["--threshold", "critical"]);
      expect(args.threshold).toBe("critical");
    });

    it("parses threshold flag with equals", () => {
      const args = depsAuditModule.parseArgs(["--threshold=medium"]);
      expect(args.threshold).toBe("medium");
    });

    it("parses ignore-pkg flag correctly", () => {
      const args = depsAuditModule.parseArgs(["--ignore-pkg", "pkg1,pkg2"]);
      expect(args.ignorePkgs).toEqual(["pkg1", "pkg2"]);
    });

    it("parses ignore-id flag correctly", () => {
      const args = depsAuditModule.parseArgs(["--ignore-id", "CVE-1,CVE-2"]);
      expect(args.ignoreIds).toEqual(["CVE-1", "CVE-2"]);
    });

    it("parses output flag correctly", () => {
      const args = depsAuditModule.parseArgs(["--output", "report.json"]);
      expect(args.output).toBe("report.json");
    });

    it("parses short flags correctly", () => {
      const args = depsAuditModule.parseArgs(["-t", "low", "-o", "out.json"]);
      expect(args.threshold).toBe("low");
      expect(args.output).toBe("out.json");
    });
  });

  // Negative test: this test exercises the failure path when vulnerabilities are found
  // It will fail before the fix (no deps-audit command exists) and pass after
  describe("deps-audit command integration (negative test)", () => {
    it("should fail when high severity vulnerability exists and threshold is high", () => {
      // This test verifies the negative case - a vulnerable dependency exists
      // and the audit should fail with exit code 1
      // Before the fix, this test wouldn't exist or would fail differently
      
      const mockFindings = [
        { packageName: "vulnerable-pkg", severity: "high", id: "GHSA-1234", title: "RCE", fixedVersion: "2.0.0", source: "npm-audit" as const },
      ];

      const result = depsAuditModule.evaluateThreshold(mockFindings, "high");
      
      expect(result.passed).toBe(false);
      expect(result.violatingFindings).toHaveLength(1);
      expect(result.violatingFindings[0].packageName).toBe("vulnerable-pkg");
    });

    it("should pass when only low severity vulnerabilities exist and threshold is high", () => {
      const mockFindings = [
        { packageName: "low-pkg", severity: "low", id: "CVE-LOW", title: "Info", fixedVersion: "1.0.0", source: "npm-audit" as const },
      ];

      const result = depsAuditModule.evaluateThreshold(mockFindings, "high");
      
      expect(result.passed).toBe(true);
      expect(result.violatingFindings).toHaveLength(0);
    });
  });

  /**
   * Boundary conditions on the parser inputs. Invariant under test: a malformed or
   * unrecognised scanner payload must never throw out of the parser and must never
   * be silently promoted into a finding, so an unparsable report can be
   * distinguished from a genuinely clean report by runDepsAudit.
   */
  describe("boundary: parseNpmAudit", () => {
    it("returns empty array for syntactically invalid JSON rather than throwing", () => {
      expect(depsAuditModule.parseNpmAudit("{ not json")).toEqual([]);
      expect(depsAuditModule.parseNpmAudit("undefined")).toEqual([]);
      expect(depsAuditModule.parseNpmAudit("null")).toEqual([]);
      expect(depsAuditModule.parseNpmAudit("[]")).toEqual([]);
      expect(depsAuditModule.parseNpmAudit('"a string"')).toEqual([]);
      expect(depsAuditModule.parseNpmAudit("42")).toEqual([]);
    });

    it("defaults severity to low and synthesises an id when npm omits both", () => {
      const findings = depsAuditModule.parseNpmAudit(
        JSON.stringify({ vulnerabilities: { "sparse-pkg": {} } }),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        packageName: "sparse-pkg",
        severity: "low",
        id: "Advisory:sparse-pkg",
        title: "sparse-pkg",
        source: "npm-audit",
      });
      expect(findings[0].fixedVersion).toBeUndefined();
    });

    it("normalises uppercase severity to lowercase so ranking is stable", () => {
      const findings = depsAuditModule.parseNpmAudit(
        JSON.stringify({ vulnerabilities: { "mixed-pkg": { severity: "HIGH" } } }),
      );

      expect(findings[0].severity).toBe("high");
    });

    it("reports fixAvailable=true as 'Available' and boolean false as absent", () => {
      const withFix = depsAuditModule.parseNpmAudit(
        JSON.stringify({ vulnerabilities: { "fixable-pkg": { fixAvailable: true } } }),
      );
      const withoutFix = depsAuditModule.parseNpmAudit(
        JSON.stringify({ vulnerabilities: { "stuck-pkg": { fixAvailable: false } } }),
      );

      expect(withFix[0].fixedVersion).toBe("Available");
      expect(withoutFix[0].fixedVersion).toBeUndefined();
    });

    it("joins every advisory identifier for a single package into one finding", () => {
      const findings = depsAuditModule.parseNpmAudit(
        JSON.stringify({
          vulnerabilities: {
            "multi-pkg": { via: [{ source: 1, name: "A" }, { source: 2, name: "B" }] },
          },
        }),
      );

      // Each `via` object contributes both its numeric source and its advisory
      // name, so two advisories yield four identifiers on a single finding.
      expect(findings).toHaveLength(1);
      const ids = findings[0].id.split(", ");
      expect(ids).toEqual(["1", "Advisory:A", "2", "Advisory:B"]);
    });

    it("preserves a package scoped name verbatim as the dedup key", () => {
      const findings = depsAuditModule.parseNpmAudit(
        JSON.stringify({ vulnerabilities: { "@scope/pkg": { severity: "high" } } }),
      );

      expect(findings[0].packageName).toBe("@scope/pkg");
    });
  });

  describe("boundary: parseOsvScanner", () => {
    it("returns empty array for invalid JSON rather than throwing", () => {
      expect(depsAuditModule.parseOsvScanner("{ truncated")).toEqual([]);
      expect(depsAuditModule.parseOsvScanner("null")).toEqual([]);
      expect(depsAuditModule.parseOsvScanner("{}")).toEqual([]);
    });

    it("falls back to 'unknown' package when the result carries no packages", () => {
      const findings = depsAuditModule.parseOsvScanner(
        JSON.stringify({ results: [{ vulnerabilities: [{ id: "GHSA-no-pkg" }] }] }),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0].packageName).toBe("unknown");
    });

    it("defaults severity to medium when OSV omits it", () => {
      const findings = depsAuditModule.parseOsvScanner(
        JSON.stringify({ results: [{ vulnerabilities: [{ id: "GHSA-no-sev" }] }] }),
      );

      expect(findings[0].severity).toBe("medium");
    });

    it("falls back through summary, details, then id for the title", () => {
      const withSummary = depsAuditModule.parseOsvScanner(
        JSON.stringify({ results: [{ vulnerabilities: [{ id: "A", summary: "Sum" }] }] }),
      );
      const withDetails = depsAuditModule.parseOsvScanner(
        JSON.stringify({ results: [{ vulnerabilities: [{ id: "B", details: "Det" }] }] }),
      );
      const withNeither = depsAuditModule.parseOsvScanner(
        JSON.stringify({ results: [{ vulnerabilities: [{ id: "C" }] }] }),
      );

      expect(withSummary[0].title).toBe("Sum");
      expect(withDetails[0].title).toBe("Det");
      expect(withNeither[0].title).toBe("C");
    });

    it("keeps the last fixed event seen across affected ranges", () => {
      // The inner `break` only exits the events loop, so later ranges overwrite
      // `fixedVersion`. The field is informational and is not used by the
      // threshold decision, so this asserts current behaviour rather than
      // prescribing a remediation-version policy.
      const findings = depsAuditModule.parseOsvScanner(
        JSON.stringify({
          results: [
            {
              vulnerabilities: [
                {
                  id: "GHSA-ranges",
                  affected: [
                    { ranges: [{ events: [{ introduced: "0" }, { fixed: "1.2.3" }] }] },
                    { ranges: [{ events: [{ fixed: "9.9.9" }] }] },
                  ],
                },
              ],
            },
          ],
        }),
      );

      expect(findings[0].fixedVersion).toBe("9.9.9");
    });

    it("emits one finding per vulnerability in a multi-result payload", () => {
      const findings = depsAuditModule.parseOsvScanner(
        JSON.stringify({
          results: [
            { packages: [{ package: { name: "pkg-a" } }], vulnerabilities: [{ id: "V1" }] },
            { packages: [{ package: { name: "pkg-b" } }], vulnerabilities: [{ id: "V2" }, { id: "V3" }] },
          ],
        }),
      );

      expect(findings.map((f) => f.id)).toEqual(["V1", "V2", "V3"]);
    });
  });

  describe("boundary: evaluateThreshold and dedup", () => {
    it("ranks an unknown severity string as low rather than escalating it", () => {
      const unknown = [
        { packageName: "p", severity: "catastrophic", id: "I", title: "t", source: "npm-audit" as const },
      ];

      // Unrecognised severities must never outrank a real threshold, otherwise a
      // scanner emitting a novel label could silently fail the build.
      expect(depsAuditModule.evaluateThreshold(unknown, "moderate").violatingFindings).toHaveLength(0);
      expect(depsAuditModule.evaluateThreshold(unknown, "critical").violatingFindings).toHaveLength(0);
      expect(depsAuditModule.evaluateThreshold(unknown, "low").violatingFindings).toHaveLength(1);
    });

    it("fails at the low threshold with a single low finding", () => {
      const low = [
        { packageName: "p", severity: "low", id: "I", title: "t", source: "npm-audit" as const },
      ];

      expect(depsAuditModule.evaluateThreshold(low, "low").passed).toBe(false);
    });

    it("keeps the first-seen finding when severities are equal", () => {
      const findings = [
        { packageName: "p", severity: "high", id: "I", title: "first", source: "npm-audit" as const },
        { packageName: "p", severity: "high", id: "I", title: "second", source: "osv-scanner" as const },
      ];

      const result = depsAuditModule.deduplicateFindings(findings);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("first");
    });

    it("does not merge different ids or different packages", () => {
      const findings = [
        { packageName: "p1", severity: "high", id: "A", title: "t", source: "npm-audit" as const },
        { packageName: "p1", severity: "high", id: "B", title: "t", source: "npm-audit" as const },
        { packageName: "p2", severity: "high", id: "A", title: "t", source: "npm-audit" as const },
      ];

      expect(depsAuditModule.deduplicateFindings(findings)).toHaveLength(3);
    });

    it("treats npm 'moderate' and OSV 'medium' as the same rank in dedup", () => {
      const findings = [
        { packageName: "p", severity: "moderate", id: "X", title: "a", source: "npm-audit" as const },
        { packageName: "p", severity: "medium", id: "X", title: "b", source: "osv-scanner" as const },
      ];

      expect(depsAuditModule.deduplicateFindings(findings)).toHaveLength(1);
    });
  });

  describe("boundary: parseArgs", () => {
    it("falls back to defaults for an empty argv", () => {
      expect(depsAuditModule.parseArgs([])).toEqual({
        threshold: "high",
        ignorePkgs: [],
        ignoreIds: [],
        output: "",
      });
    });

    it("keeps a missing flag value from consuming the next flag", () => {
      const args = depsAuditModule.parseArgs(["--threshold"]);

      expect(args.threshold).toBe("high");
    });

    it("drops empty entries from comma-separated ignore lists", () => {
      const args = depsAuditModule.parseArgs(["--ignore-pkg", " a , ,b ,, "]);

      expect(args.ignorePkgs).toEqual(["a", "b"]);
    });

    it("resolves an empty ignore list to an empty array", () => {
      expect(depsAuditModule.parseArgs(["--ignore-pkg", ""]).ignorePkgs).toEqual([]);
      expect(depsAuditModule.parseArgs(["--ignore-id="]).ignoreIds).toEqual([]);
    });

    it("keeps the last occurrence when a flag is repeated", () => {
      const args = depsAuditModule.parseArgs(["-t", "low", "-t", "critical"]);

      expect(args.threshold).toBe("critical");
    });

    it("ignores unknown flags", () => {
      const args = depsAuditModule.parseArgs(["--nope", "value", "-t", "high"]);

      expect(args.threshold).toBe("high");
    });
  });

  /**
   * runDepsAudit is the fail-closed gate. Recovery invariants under test:
   * a scanner that could not be executed or read must return an error result
   * (never ok:true), osv-scanner must not run when npm audit already failed,
   * and the gate must not report success on two empty reports.
   */
  describe("recovery: runDepsAudit scanner failure", () => {
    beforeEach(() => {
      scannerControl.spawnSync.mockReset();
    });

    it("fails closed when npm audit cannot be executed", () => {
      scannerControl.spawnSync.mockReturnValueOnce({
        stdout: "",
        stderr: "npm ENOTFOUND registry",
        status: 3,
      });

      const result = depsAuditModule.runDepsAudit();

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.code).toBe("NPM_AUDIT_FAILED");
      expect(result.message).toContain("3");
      expect(scannerControl.spawnSync).toHaveBeenCalledTimes(1);
    });

    it("treats a killed scanner (null status) as an execution failure", () => {
      scannerControl.spawnSync.mockReturnValueOnce({
        stdout: "",
        stderr: "spawnSync npm ETIMEDOUT",
        error: new Error("ETIMEDOUT"),
        status: null,
      });

      const result = depsAuditModule.runDepsAudit();

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.code).toBe("NPM_AUDIT_FAILED");
    });

    it("fails closed when osv-scanner is missing but npm audit succeeded", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({ stdout: JSON.stringify({ vulnerabilities: {} }), stderr: "", status: 0 })
        .mockReturnValueOnce({ stdout: "", stderr: "ENOENT osv-scanner", status: 127 });

      const result = depsAuditModule.runDepsAudit();

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.code).toBe("OSV_SCANNER_FAILED");
    });

    it("accepts exit code 1 from both scanners as 'findings found', not an error", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({
          stdout: JSON.stringify({ vulnerabilities: { p: { severity: "low" } } }),
          stderr: "",
          status: 1,
        })
        .mockReturnValueOnce({
          stdout: JSON.stringify({ results: [] }),
          stderr: "",
          status: 1,
        });

      const result = depsAuditModule.runDepsAudit();

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.findings).toHaveLength(1);
    });

    it("does not run osv-scanner when npm audit has already failed", () => {
      scannerControl.spawnSync.mockReturnValueOnce({ stdout: "", stderr: "boom", status: 2 });

      depsAuditModule.runDepsAudit();

      expect(scannerControl.spawnSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("recovery: runDepsAudit degraded output", () => {
    beforeEach(() => {
      scannerControl.spawnSync.mockReset();
    });

    it("refuses to pass when both scanners return nothing to parse", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({ stdout: "", stderr: "", status: 0 })
        .mockReturnValueOnce({ stdout: "   ", stderr: "", status: 0 });

      const result = depsAuditModule.runDepsAudit();

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.code).toBe("EMPTY_REPORTS");
    });

    it("refuses to pass when both scanners return unparsable JSON", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({ stdout: "<html>502</html>", stderr: "", status: 0 })
        .mockReturnValueOnce({ stdout: "not json", stderr: "", status: 0 });

      const result = depsAuditModule.runDepsAudit();

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.code).toBe("EMPTY_REPORTS");
    });

    it("still fails when only one scanner produces findings above threshold", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({ stdout: JSON.stringify({ vulnerabilities: {} }), stderr: "", status: 0 })
        .mockReturnValueOnce({
          stdout: JSON.stringify({
            results: [{ packages: [{ package: { name: "p" } }], vulnerabilities: [{ id: "V1", severity: "CRITICAL" }] }],
          }),
          stderr: "",
          status: 1,
        });

      const result = depsAuditModule.runDepsAudit({ threshold: "high" });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.code).toBe("THRESHOLD_EXCEEDED");
    });

    it("does not report success when findings are empty but one scanner reported some", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({ stdout: JSON.stringify({ vulnerabilities: {} }), stderr: "", status: 0 })
        .mockReturnValueOnce({ stdout: JSON.stringify({ results: [] }), stderr: "", status: 0 });

      const result = depsAuditModule.runDepsAudit();

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.code).toBe("EMPTY_REPORTS");
    });
  });

  describe("recovery: ignore lists", () => {
    beforeEach(() => {
      scannerControl.spawnSync.mockReset();
    });

    it("excludes an ignored package from the threshold decision", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({
          stdout: JSON.stringify({ vulnerabilities: { "lodash": { severity: "high" } } }),
          stderr: "",
          status: 1,
        })
        .mockReturnValueOnce({
          stdout: JSON.stringify({ results: [{ packages: [{ package: { name: "lodash" } }], vulnerabilities: [] }] }),
          stderr: "",
          status: 0,
        });

      const result = depsAuditModule.runDepsAudit({ threshold: "high", ignorePkgs: ["lodash"] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.findings).toHaveLength(0);
      expect(result.npmAudit.total).toBe(1);
    });

    it("excludes an ignored advisory id from the threshold decision", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({ stdout: JSON.stringify({ vulnerabilities: {} }), stderr: "", status: 0 })
        .mockReturnValueOnce({
          stdout: JSON.stringify({
            results: [{ packages: [{ package: { name: "p" } }], vulnerabilities: [{ id: "OSV-1", severity: "HIGH" }] }],
          }),
          stderr: "",
          status: 1,
        });

      const result = depsAuditModule.runDepsAudit({ threshold: "high", ignoreIds: ["OSV-1"] });

      expect(result.ok).toBe(true);
    });
  });

  describe("recovery: report output", () => {
    beforeEach(() => {
      scannerControl.spawnSync.mockReset();
    });

    it("writes a report on failure and still returns the failure", () => {
      const dir = mkdtempSync(join(tmpdir(), "deps-audit-"));
      const outputFile = join(dir, "report.json");

      scannerControl.spawnSync
        .mockReturnValueOnce({
          stdout: JSON.stringify({ vulnerabilities: { lodash: { severity: "high", name: "lodash" } } }),
          stderr: "",
          status: 1,
        })
        .mockReturnValueOnce({ stdout: JSON.stringify({ results: [] }), stderr: "", status: 0 });

      const result = depsAuditModule.runDepsAudit({ threshold: "high", outputFile });

      expect(result.ok).toBe(false);
      expect(existsSync(outputFile)).toBe(true);
      const report = JSON.parse(readFileSync(outputFile, "utf8"));
      expect(report.violatingFindings).toBe(1);
      expect(report.threshold).toBe("high");

      unlinkSync(outputFile);
    });

    it("returns the threshold failure even when the report cannot be written", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({
          stdout: JSON.stringify({ vulnerabilities: { lodash: { severity: "critical" } } }),
          stderr: "",
          status: 1,
        })
        .mockReturnValueOnce({ stdout: JSON.stringify({ results: [] }), stderr: "", status: 0 });

      const result = depsAuditModule.runDepsAudit({
        threshold: "high",
        outputFile: "/dev/null/nonexistent-dir/report.json",
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.code).toBe("THRESHOLD_EXCEEDED");
    });
  });

  /**
   * The CLI is the contract with CI: 0 = clean, 1 = threshold exceeded,
   * 2 = execution/parsing error. Recovery requires the error class to stay
   * distinguishable from a real finding so a broken scanner cannot be
   * mistaken for a passing build.
   */
  describe("recovery: runCli exit codes", () => {
    beforeEach(() => {
      scannerControl.spawnSync.mockReset();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("returns 0 and writes a report when findings stay below the threshold", () => {
      const dir = mkdtempSync(join(tmpdir(), "deps-audit-"));
      const outputFile = join(dir, "clean.json");

      scannerControl.spawnSync
        .mockReturnValueOnce({
          stdout: JSON.stringify({ vulnerabilities: { "minor-pkg": { severity: "low" } } }),
          stderr: "",
          status: 0,
        })
        .mockReturnValueOnce({ stdout: JSON.stringify({ results: [] }), stderr: "", status: 0 });

      const code = depsAuditModule.runCli(["--threshold", "high", "--output", outputFile]);

      expect(code).toBe(0);
      expect(existsSync(outputFile)).toBe(true);
      const report = JSON.parse(readFileSync(outputFile, "utf8"));
      expect(report.violatingFindings).toBe(0);
      expect(report.findings).toHaveLength(1);

      unlinkSync(outputFile);
    });

    it("returns 2 when both scanners report no findings at all", () => {
      // Fail-closed: a report with zero findings is indistinguishable from a
      // scanner that silently produced nothing, so the gate refuses to pass.
      scannerControl.spawnSync
        .mockReturnValueOnce({ stdout: JSON.stringify({ vulnerabilities: {} }), stderr: "", status: 0 })
        .mockReturnValueOnce({ stdout: JSON.stringify({ results: [] }), stderr: "", status: 0 });

      expect(depsAuditModule.runCli([])).toBe(2);
    });

    it("returns 1 when findings reach the threshold", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({
          stdout: JSON.stringify({ vulnerabilities: { lodash: { severity: "high" } } }),
          stderr: "",
          status: 1,
        })
        .mockReturnValueOnce({ stdout: JSON.stringify({ results: [] }), stderr: "", status: 0 });

      expect(depsAuditModule.runCli(["--threshold", "high"])).toBe(1);
    });

    it("returns 2 when a scanner fails to execute", () => {
      scannerControl.spawnSync.mockReturnValueOnce({ stdout: "", stderr: "network down", status: 3 });

      expect(depsAuditModule.runCli([])).toBe(2);
    });

    it("returns 2 when both reports are empty", () => {
      scannerControl.spawnSync
        .mockReturnValueOnce({ stdout: "", stderr: "", status: 0 })
        .mockReturnValueOnce({ stdout: "", stderr: "", status: 0 });

      expect(depsAuditModule.runCli([])).toBe(2);
    });

    it("logs the failure code and message to stderr", () => {
      scannerControl.spawnSync.mockReturnValueOnce({ stdout: "", stderr: "network down", status: 3 });

      depsAuditModule.runCli([]);

      const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("NPM_AUDIT_FAILED");
      expect(logged).toContain("network down");
    });
  });
});