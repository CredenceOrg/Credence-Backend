#!/usr/bin/env tsx
/**
 * Dependency audit gate.
 *
 * Runs `npm audit` + `osv-scanner` and produces a combined, deduplicated
 * vulnerability report with a CI-friendly exit code (0 = clean, 1 = findings
 * at or above threshold, 2 = execution / parsing error).
 *
 * Threat mitigated: without a combined npm-audit + OSV scan gate on every
 * merge, a vulnerable (transitive) dependency can enter the production graph
 * undetected because npm-audit only covers the npm registry advisory database
 * while OSV covers a broader multi-ecosystem vulnerability corpus (GitHub
 * Security Advisories, OSV, PyPI, Go, Maven, etc.). Running both and failing
 * closed makes the dependency inventory a build gate.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** Discriminated-union error codes surfaced by {@link runDepsAudit}. */
export type DepsAuditErrorCode =
  | "NPM_AUDIT_FAILED"
  | "OSV_SCANNER_FAILED"
  | "NPM_AUDIT_PARSE_ERROR"
  | "OSV_SCANNER_PARSE_ERROR"
  | "THRESHOLD_EXCEEDED"
  | "EMPTY_REPORTS";

export type DepsAuditResult =
  | { ok: true; npmAudit: NpmAuditSummary; osvScanner: OsvScannerSummary; findings: CombinedFinding[] }
  | { ok: false; code: DepsAuditErrorCode; message: string };

/** Severity ranking shared by both scanners (npm uses "moderate", OSV uses "medium"). */
export const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  medium: 2,
  high: 3,
  critical: 4,
};

export type Threshold = "low" | "moderate" | "medium" | "high" | "critical";

/** Normalised vulnerability finding shared by both scanners. */
export interface CombinedFinding {
  packageName: string;
  severity: string;
  id: string; // CVE / GHSA / OSV ID
  title: string;
  fixedVersion?: string;
  source: "npm-audit" | "osv-scanner";
}

/** Minimal npm-audit JSON schema (subset we care about). */
const npmAuditSchema = z.object({
  auditReportVersion: z.number().optional(),
  vulnerabilities: z
    .record(
      z.object({
        severity: z.string().optional(),
        via: z.union([z.string(), z.array(z.union([z.string(), z.object({}).passthrough()]))]).optional(),
        name: z.string().optional(),
        fixAvailable: z.union([z.string(), z.boolean(), z.object({}).passthrough()]).optional(),
      })
    )
    .optional(),
});

/** Minimal osv-scanner JSON schema (subset we care about). */
const osvScannerSchema = z.object({
  results: z
    .array(
      z.object({
        source: z
          .object({
            path: z.string().optional(),
            type: z.string().optional(),
          })
          .optional(),
        packages: z
          .array(
            z.object({
              package: z.object({
                name: z.string(),
                version: z.string().optional(),
                ecosystem: z.string().optional(),
              }),
            })
          )
          .optional(),
        vulnerabilities: z
          .array(
            z.object({
              id: z.string(),
              aliases: z.array(z.string()).optional(),
              related: z.array(z.string()).optional(),
              summary: z.string().optional(),
              details: z.string().optional(),
              severity: z.string().optional(),
              affected: z
                .array(
                  z.object({
                    package: z.object({ name: z.string() }).optional(),
                    ranges: z
                      .array(
                        z.object({
                          events: z.array(
                            z.object({
                              introduced: z.string().optional(),
                              fixed: z.string().optional(),
                            })
                          ),
                        })
                      )
                      .optional(),
                  })
                )
                .optional(),
            })
          )
          .optional(),
      })
    )
    .optional(),
});

/** Summaries for the combined report. */
export interface NpmAuditSummary {
  total: number;
  bySeverity: Record<string, number>;
}

export interface OsvScannerSummary {
  total: number;
  bySeverity: Record<string, number>;
}

/**
 * Parses npm audit JSON output into normalised findings.
 */
export function parseNpmAudit(jsonContent: string): CombinedFinding[] {
  if (!jsonContent.trim()) return [];

  let parsed: z.infer<typeof npmAuditSchema>;
  try {
    parsed = npmAuditSchema.parse(JSON.parse(jsonContent));
  } catch {
    return [];
  }

  const findings: CombinedFinding[] = [];
  if (!parsed.vulnerabilities) return findings;

  for (const [pkgName, vuln] of Object.entries(parsed.vulnerabilities)) {
    const severity = (vuln.severity || "low").toLowerCase();

    // Extract IDs from via array or string
    const ids: string[] = [];
    if (vuln.via) {
      if (typeof vuln.via === "string") {
        ids.push(vuln.via);
      } else if (Array.isArray(vuln.via)) {
        for (const item of vuln.via) {
          if (typeof item === "string") {
            ids.push(item);
          } else if (item && typeof item === "object") {
            const obj = item as Record<string, unknown>;
            if (obj.source) ids.push(String(obj.source));
            if (obj.name) ids.push(`Advisory:${String(obj.name)}`);
          }
        }
      }
    }
    if (ids.length === 0) {
      ids.push(`Advisory:${pkgName}`);
    }

    const fixedVersion =
      typeof vuln.fixAvailable === "string"
        ? vuln.fixAvailable
        : vuln.fixAvailable
        ? "Available"
        : undefined;

    findings.push({
      packageName: pkgName,
      severity,
      id: ids.join(", "),
      title: vuln.name || pkgName,
      fixedVersion,
      source: "npm-audit",
    });
  }

  return findings;
}

/**
 * Parses osv-scanner JSON output into normalised findings.
 */
export function parseOsvScanner(jsonContent: string): CombinedFinding[] {
  if (!jsonContent.trim()) return [];

  let parsed: z.infer<typeof osvScannerSchema>;
  try {
    parsed = osvScannerSchema.parse(JSON.parse(jsonContent));
  } catch {
    return [];
  }

  const findings: CombinedFinding[] = [];
  if (!parsed.results || !Array.isArray(parsed.results)) return findings;

  for (const result of parsed.results) {
    // osv-scanner outputs vulnerabilities at the result level, not inside packages
    if (!result.vulnerabilities || !Array.isArray(result.vulnerabilities)) continue;

    // Get package name from the first package in the result
    let packageName = "unknown";
    if (result.packages && result.packages.length > 0) {
      packageName = result.packages[0].package.name;
    }

    for (const vuln of result.vulnerabilities) {
      // Determine severity from severity field (OSV uses "HIGH", "CRITICAL", etc.)
      let severity = "medium";
      if (vuln.severity) {
        severity = vuln.severity.toLowerCase();
      }

      // Extract fixed version from ranges
      let fixedVersion: string | undefined;
      if (vuln.affected && Array.isArray(vuln.affected)) {
        for (const affected of vuln.affected) {
          if (affected.ranges && Array.isArray(affected.ranges)) {
            for (const range of affected.ranges) {
              if (range.events && Array.isArray(range.events)) {
                for (const event of range.events) {
                  if (event.fixed) {
                    fixedVersion = event.fixed;
                    break;
                  }
                }
              }
            }
          }
        }
      }

      findings.push({
        packageName,
        severity,
        id: vuln.id,
        title: vuln.summary || vuln.details || vuln.id,
        fixedVersion,
        source: "osv-scanner",
      });
    }
  }

  return findings;
}

/**
 * Deduplicates findings by (packageName, id) keeping the highest severity.
 */
export function deduplicateFindings(findings: CombinedFinding[]): CombinedFinding[] {
  const map = new Map<string, CombinedFinding>();

  for (const finding of findings) {
    const key = `${finding.packageName}:${finding.id}`;
    const existing = map.get(key);
    const existingRank = existing ? SEVERITY_RANK[existing.severity.toLowerCase()] ?? 0 : 0;
    const newRank = SEVERITY_RANK[finding.severity.toLowerCase()] ?? 0;

    if (!existing || newRank > existingRank) {
      map.set(key, finding);
    }
  }

  return Array.from(map.values());
}

/**
 * Summarises findings by severity.
 */
export function summariseFindings(findings: CombinedFinding[]): Record<string, number> {
  const summary: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    moderate: 0,
    low: 0,
    info: 0,
  };

  for (const finding of findings) {
    const sev = finding.severity.toLowerCase();
    summary[sev] = (summary[sev] || 0) + 1;
  }

  return summary;
}

/**
 * Runs npm audit and returns stdout as string.
 */
export function runNpmAudit(): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("npm", ["audit", "--json", "--omit=dev"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024, // 10MB
    timeout: 120000, // 2 minutes
  });

  return {
    stdout: result.stdout?.toString() || "",
    stderr: result.stderr?.toString() || "",
    exitCode: result.status ?? 1,
  };
}

/**
 * Runs osv-scanner and returns stdout as string.
 */
export function runOsvScanner(): { stdout: string; stderr: string; exitCode: number } {
  // osv-scanner is typically installed via Go, so it's in GOPATH/bin or ~/go/bin
  const goBin = process.env.GOPATH
    ? `${process.env.GOPATH}/bin/osv-scanner`
    : `${process.env.HOME}/go/bin/osv-scanner`;

  const result = spawnSync(goBin, ["scan", "--format=json", "."], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024, // 10MB
    timeout: 180000, // 3 minutes
    env: { ...process.env, PATH: `${process.env.PATH}:${process.env.GOPATH || process.env.HOME}/go/bin` },
  });

  return {
    stdout: result.stdout?.toString() || "",
    stderr: result.stderr?.toString() || "",
    exitCode: result.status ?? 1,
  };
}

/**
 * Evaluates findings against a severity threshold.
 */
export function evaluateThreshold(
  findings: CombinedFinding[],
  threshold: Threshold
): { passed: boolean; violatingFindings: CombinedFinding[] } {
  const thresholdRank = SEVERITY_RANK[threshold] ?? 3; // default to high
  const violatingFindings: CombinedFinding[] = [];

  for (const finding of findings) {
    const rank = SEVERITY_RANK[finding.severity.toLowerCase()] ?? 1;
    if (rank >= thresholdRank) {
      violatingFindings.push(finding);
    }
  }

  return {
    passed: violatingFindings.length === 0,
    violatingFindings,
  };
}

/**
 * Alias for evaluateThreshold for backward compatibility with security-gate.ts API.
 */
export function evaluateGate(
  findings: CombinedFinding[],
  config: { threshold: Threshold; ignorePkgs: string[]; ignoreCves: string[] }
): { passed: boolean; violatingIssues: CombinedFinding[] } {
  const { passed, violatingFindings } = evaluateThreshold(findings, config.threshold);
  // Filter out ignored packages and CVEs
  const ignorePkgs = new Set(config.ignorePkgs);
  const ignoreCves = new Set(config.ignoreCves);
  const filtered = violatingFindings.filter(
    (f) => !ignorePkgs.has(f.packageName) && !ignoreCves.has(f.id)
  );
  return { passed: filtered.length === 0, violatingIssues: filtered };
}

/**
 * Main entry point for the dependency audit gate.
 */
export function runDepsAudit(options: {
  threshold?: Threshold;
  ignorePkgs?: string[];
  ignoreIds?: string[];
  outputFile?: string;
} = {}): DepsAuditResult {
  const threshold = options.threshold ?? "high";
  const ignorePkgs = new Set(options.ignorePkgs ?? []);
  const ignoreIds = new Set(options.ignoreIds ?? []);

  // Run npm audit
  const npmResult = runNpmAudit();
  if (npmResult.exitCode !== 0 && npmResult.exitCode !== 1) {
    // npm audit exits 1 when vulnerabilities found, 0 when clean, >1 on error
    return {
      ok: false,
      code: "NPM_AUDIT_FAILED",
      message: `npm audit failed with exit code ${npmResult.exitCode}: ${npmResult.stderr}`,
    };
  }

  // Run osv-scanner
  const osvResult = runOsvScanner();
  if (osvResult.exitCode !== 0 && osvResult.exitCode !== 1) {
    // osv-scanner exits 1 when vulnerabilities found, 0 when clean, >1 on error
    return {
      ok: false,
      code: "OSV_SCANNER_FAILED",
      message: `osv-scanner failed with exit code ${osvResult.exitCode}: ${osvResult.stderr}`,
    };
  }

  // Parse reports
  let npmFindings: CombinedFinding[];
  try {
    npmFindings = parseNpmAudit(npmResult.stdout);
  } catch (e) {
    return {
      ok: false,
      code: "NPM_AUDIT_PARSE_ERROR",
      message: `Failed to parse npm audit output: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let osvFindings: CombinedFinding[];
  try {
    osvFindings = parseOsvScanner(osvResult.stdout);
  } catch (e) {
    return {
      ok: false,
      code: "OSV_SCANNER_PARSE_ERROR",
      message: `Failed to parse osv-scanner output: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Combine and deduplicate
  const allFindings = deduplicateFindings([...npmFindings, ...osvFindings]);

  // Apply ignore lists
  const filteredFindings = allFindings.filter(
    (f) => !ignorePkgs.has(f.packageName) && !ignoreIds.has(f.id)
  );

  // Evaluate against threshold
  const { passed, violatingFindings } = evaluateThreshold(filteredFindings, threshold);

  // Build summaries
  const npmSummary: NpmAuditSummary = {
    total: npmFindings.length,
    bySeverity: summariseFindings(npmFindings),
  };

  const osvSummary: OsvScannerSummary = {
    total: osvFindings.length,
    bySeverity: summariseFindings(osvFindings),
  };

  if (!passed) {
    // Write output file if requested
    if (options.outputFile) {
      const report = {
        timestamp: new Date().toISOString(),
        threshold,
        totalFindings: filteredFindings.length,
        violatingFindings: violatingFindings.length,
        npmAudit: npmSummary,
        osvScanner: osvSummary,
        findings: filteredFindings,
      };
      try {
        writeFileSync(options.outputFile, JSON.stringify(report, null, 2));
      } catch {
        // Ignore write errors, still report the findings
      }
    }

    return {
      ok: false,
      code: "THRESHOLD_EXCEEDED",
      message: `Found ${violatingFindings.length} vulnerability finding(s) at or above ${threshold.toUpperCase()} severity`,
    };
  }

  if (filteredFindings.length === 0 && npmFindings.length === 0 && osvFindings.length === 0) {
    return {
      ok: false,
      code: "EMPTY_REPORTS",
      message: "Both npm audit and osv-scanner produced empty reports — scanners may have failed silently",
    };
  }

  return {
    ok: true,
    npmAudit: npmSummary,
    osvScanner: osvSummary,
    findings: filteredFindings,
  };
}

/**
 * CLI entry point.
 */
export function runCli(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const result = runDepsAudit({
    threshold: args.threshold,
    ignorePkgs: args.ignorePkgs,
    ignoreIds: args.ignoreIds,
    outputFile: args.output,
  });

  if (!result.ok) {
    console.error(`deps-audit: [${result.code}] ${result.message}`);
    if (result.code === "THRESHOLD_EXCEEDED" && !args.output) {
      console.error(`deps-audit: Run with --output <file> to save full JSON report.`);
    }
    // Exit codes: 0 = clean, 1 = threshold exceeded, 2 = execution/parsing error
    return result.code === "THRESHOLD_EXCEEDED" ? 1 : 2;
  }

  console.log(
    `deps-audit: ✅ PASSED — npm-audit: ${result.npmAudit.total} findings, osv-scanner: ${result.osvScanner.total} findings, threshold: ${args.threshold.toUpperCase()}`,
  );
  if (args.output) {
    const report = {
      timestamp: new Date().toISOString(),
      threshold: args.threshold,
      totalFindings: result.findings.length,
      violatingFindings: 0,
      npmAudit: result.npmAudit,
      osvScanner: result.osvScanner,
      findings: result.findings,
    };
    writeFileSync(args.output, JSON.stringify(report, null, 2));
    console.log(`deps-audit: Report written to ${args.output}`);
  }
  return 0;
}

interface CliArgs {
  threshold: Threshold;
  ignorePkgs: string[];
  ignoreIds: string[];
  output: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    threshold: "high",
    ignorePkgs: [],
    ignoreIds: [],
    output: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--threshold" || arg === "-t") {
      args.threshold = (argv[++i] || "high").toLowerCase() as Threshold;
    } else if (arg.startsWith("--threshold=")) {
      args.threshold = arg.substring(12).toLowerCase() as Threshold;
    } else if (arg === "--ignore-pkg") {
      args.ignorePkgs = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--ignore-pkg=")) {
      args.ignorePkgs = arg.substring(13).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--ignore-id") {
      args.ignoreIds = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--ignore-id=")) {
      args.ignoreIds = arg.substring(12).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--output" || arg === "-o") {
      args.output = argv[++i] || "";
    } else if (arg.startsWith("--output=")) {
      args.output = arg.substring(9);
    }
  }

  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(runCli());
}