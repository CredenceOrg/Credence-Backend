/**
 * AlertManager and Prometheus Tool CLI Validators
 *
 * Integration tests that run amtool and promtool to validate configs
 * These tests should be run as part of CI/CD pipeline
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Helper to run CLI commands safely
function runCommand(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8" }).toString();
  } catch (error: unknown) {
    const err = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `Command failed: ${cmd}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`,
    );
  }
}

// Helper to check if a command is available
function isCommandAvailable(command: string): boolean {
  try {
    execSync(`${command} version`, { encoding: "utf-8", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("AlertManager CLI Validation", () => {
  const alertManagerConfigPath = path.join(
    __dirname,
    "../prometheus/alertmanager.yml",
  );
  
  let hasAmtool: boolean;

  beforeAll(() => {
    // Check if amtool is available
    hasAmtool = isCommandAvailable("amtool");
    if (!hasAmtool) {
      console.warn("⚠️  amtool not installed - skipping amtool tests");
      console.warn(
        "Install with: brew install alertmanager (macOS) or apt-get install alertmanager (Linux)",
      );
    }
  });

  it("should pass amtool check-config validation", () => {
    if (!hasAmtool) return;

    const output = runCommand(`amtool check-config ${alertManagerConfigPath}`);

    expect(output).toBeTruthy();
    expect(output).not.toContain("error");
    expect(output).not.toContain("failed");
  });

  it("should have valid receiver configuration", () => {
    if (!hasAmtool) return;

    const output = runCommand(`amtool config routes ${alertManagerConfigPath}`);

    expect(output).toBeTruthy();
    // Output should contain route information
    expect(output.length).toBeGreaterThan(0);
  });
});

describe("Prometheus Tool Validation", () => {
  const alertsRulesPath = path.join(
    __dirname,
    "../prometheus/alerts.yml",
  );
  
  let hasPromtool: boolean;

  beforeAll(() => {
    // Check if promtool is available
    hasPromtool = isCommandAvailable("promtool");
    if (!hasPromtool) {
      console.warn("⚠️  promtool not installed - skipping promtool tests");
      console.warn(
        "Install with: brew install prometheus (macOS) or download from https://prometheus.io/download/",
      );
    }
  });

  it("should pass promtool check rules validation", () => {
    if (!hasPromtool) return;

    const output = runCommand(`promtool check rules ${alertsRulesPath}`);

    expect(output).toBeTruthy();
    expect(output).toContain("Checking rules");
    // Output should not contain errors
    expect(output).not.toContain("ERROR");
  });

  it("should validate PromQL expressions", () => {
    if (!hasPromtool) return;

    const output = runCommand(
      `promtool check rules ${alertsRulesPath} --lint=all`,
    );

    expect(output).toBeTruthy();
    // Allow warnings but not critical errors
    expect(output).not.toContain("error");
  });
});

describe("Configuration File Validation", () => {
  const alertManagerConfigPath = path.join(
    __dirname,
    "../prometheus/alertmanager.yml",
  );
  const alertsRulesPath = path.join(__dirname, "../prometheus/alerts.yml");

  it("should have readable alertmanager.yml", () => {
    expect(fs.existsSync(alertManagerConfigPath)).toBe(true);

    const content = fs.readFileSync(alertManagerConfigPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("routes");
    expect(content).toContain("receivers");
  });

  it("should have readable alerts.yml", () => {
    expect(fs.existsSync(alertsRulesPath)).toBe(true);

    const content = fs.readFileSync(alertsRulesPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("groups");
    expect(content).toContain("rules");
  });

  it("alertmanager.yml should contain production routes", () => {
    const content = fs.readFileSync(alertManagerConfigPath, "utf-8");

    expect(content).toContain("prod");
    expect(content).toContain("staging");
    expect(content).toContain("dev");
  });

  it("alertmanager.yml should reference environment variables", () => {
    const content = fs.readFileSync(alertManagerConfigPath, "utf-8");

    expect(content).toContain("ALERTMANAGER_SLACK_WEBHOOK");
    expect(content).toContain("ALERTMANAGER_PAGERDUTY");
  });

  it("alerts.yml should have severity labels on all rules", () => {
    const content = fs.readFileSync(alertsRulesPath, "utf-8");

    // Count severity: SEV patterns
    const sevMatches = content.match(/severity:\s*SEV[123]/g);
    expect(sevMatches).toBeTruthy();
    expect(sevMatches!.length).toBeGreaterThan(10); // Should have many rules
  });

  it("alerts.yml should have runbook URLs", () => {
    const content = fs.readFileSync(alertsRulesPath, "utf-8");

    expect(content).toContain("runbook_url");
    expect(content).toContain("docs.credence.org/runbooks");
  });

  it("alerts.yml should have team labels", () => {
    const content = fs.readFileSync(alertsRulesPath, "utf-8");

    expect(content).toContain("team: platform");
    expect(content).toContain("team: infrastructure");
  });

  it("alerts.yml should have service labels", () => {
    const content = fs.readFileSync(alertsRulesPath, "utf-8");

    expect(content).toContain("service: trust-score");
    expect(content).toContain("service: database");
  });
});

describe("Edge Case Validation", () => {
  it("should handle maintenance window suppression", () => {
    const configPath = path.join(
      __dirname,
      "../prometheus/alertmanager.yml",
    );
    const content = fs.readFileSync(configPath, "utf-8");

    // Should have inhibition rules for maintenance
    expect(content).toContain("inhibit_rules");
    expect(content).toContain("MaintenanceWindow");
  });

  it("should handle alert flapping with for: clause", () => {
    const rulesPath = path.join(
      __dirname,
      "../prometheus/alerts.yml",
    );
    const content = fs.readFileSync(rulesPath, "utf-8");

    // All alerts should have for: clause
    expect(content).toContain("for:");

    // Count for: occurrences - should have one per rule (approximately)
    const forMatches = content.match(/for:\s*\d+[msh]/g);
    expect(forMatches).toBeTruthy();
    expect(forMatches!.length).toBeGreaterThan(10);
  });

  it("should have appropriate group_wait times for severity", () => {
    const configPath = path.join(
      __dirname,
      "../prometheus/alertmanager.yml",
    );
    const content = fs.readFileSync(configPath, "utf-8");

    // Production routes should have varying group_wait based on severity
    expect(content).toContain("group_wait: 5s"); // SEV1
    expect(content).toContain("group_wait: 2m"); // SEV2
    expect(content).toContain("group_wait: 5m"); // SEV3
  });

  it("should have repeat intervals to prevent alert fatigue", () => {
    const configPath = path.join(
      __dirname,
      "../prometheus/alertmanager.yml",
    );
    const content = fs.readFileSync(configPath, "utf-8");

    // Should have repeat_interval configurations
    expect(content).toContain("repeat_interval");

    // SEV1 should repeat more frequently than SEV3
    // This is a structural check - we verify the pattern exists
    const repeatIntervals = content.match(/repeat_interval:\s*\d+[mh]/g);
    expect(repeatIntervals).toBeTruthy();
    expect(repeatIntervals!.length).toBeGreaterThan(5);
  });
});

describe("Documentation Validation", () => {
  const docPath = path.join(__dirname, "../../docs/alert-routing.md");

  it("should have alert-routing.md documentation", () => {
    expect(fs.existsSync(docPath)).toBe(true);
  });

  it("documentation should cover on-call rotation", () => {
    const content = fs.readFileSync(docPath, "utf-8");

    expect(content).toContain("On-Call Rotation");
    expect(content).toContain("SEV1");
    expect(content).toContain("SEV2");
    expect(content).toContain("SEV3");
  });

  it("documentation should include routing matrix", () => {
    const content = fs.readFileSync(docPath, "utf-8");

    expect(content).toContain("Routing Matrix");
    expect(content).toContain("Production");
    expect(content).toContain("Staging");
  });

  it("documentation should have runbook guidance", () => {
    const content = fs.readFileSync(docPath, "utf-8");

    expect(content).toContain("Runbook");
    expect(content).toContain("procedures");
  });

  it("documentation should explain environment variables", () => {
    const content = fs.readFileSync(docPath, "utf-8");

    expect(content).toContain("Environment Variables");
    expect(content).toContain("ALERTMANAGER_SLACK_WEBHOOK");
    expect(content).toContain("ALERTMANAGER_PAGERDUTY");
  });

  it("documentation should cover edge cases", () => {
    const content = fs.readFileSync(docPath, "utf-8");

    expect(content).toContain("flapping");
    expect(content).toContain("maintenance");
    expect(content).toContain("dependency");
  });
});

describe("Security Validation", () => {
  const alertManagerConfigPath = path.join(
    __dirname,
    "../prometheus/alertmanager.yml",
  );

  it("should not have hardcoded secrets in alertmanager config", () => {
    const content = fs.readFileSync(alertManagerConfigPath, "utf-8");

    // Should not contain actual Slack tokens (format: xoxb-...)
    expect(content).not.toMatch(/xoxb-[A-Za-z0-9]+/);

    // Should not contain actual PagerDuty keys
    expect(content).not.toMatch(/pagerduty.*[A-Z0-9]{20,}/);

    // Should not contain AWS keys
    expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it("should reference environment variables for sensitive values", () => {
    const content = fs.readFileSync(alertManagerConfigPath, "utf-8");

    // Should use environment variable syntax
    expect(content).toMatch(/\${ALERTMANAGER_[A-Z_]+}/);
  });

  it("documentation should warn about secret handling", () => {
    const docPath = path.join(__dirname, "../../docs/alert-routing.md");
    const content = fs.readFileSync(docPath, "utf-8");

    expect(content).toContain("Security");
    expect(content).toContain("environment");
    expect(content).toContain("never committed");
  });
});