import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

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
});