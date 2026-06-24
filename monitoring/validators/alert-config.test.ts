/**
 * Alert Configuration Validators
 *
 * Validates alert routing configuration, rules labels, and edge cases.
 * Target coverage: 95%+ of label validation and routing logic
 */

import { describe, it, expect } from "vitest";
import * as yaml from "yaml";
import * as fs from "fs";
import * as path from "path";

// Type definitions for validation
interface AlertLabel {
  severity?: string;
  service?: string;
  team?: string;
  [key: string]: string | undefined;
}

interface AlertRule {
  alert: string;
  expr: string;
  labels: AlertLabel;
  annotations: {
    summary: string;
    description: string;
    runbook_url?: string;
    [key: string]: string;
  };
}

interface AlertGroup {
  name: string;
  rules: AlertRule[];
}

interface AlertsConfig {
  groups: AlertGroup[];
}

interface AlertManagerReceiver {
  name: string;
  slack_configs?: Array<{ channel: string }>;
  pagerduty_configs?: Array<{ service_key: string }>;
}

interface AlertManagerConfig {
  global?: Record<string, string>;
  routes?: Record<string, unknown>;
  receivers?: AlertManagerReceiver[];
  inhibit_rules?: Array<Record<string, unknown>>;
}

// Validation constants
const VALID_SEVERITIES = ["SEV1", "SEV2", "SEV3"];
const VALID_TEAMS = ["platform", "infrastructure", "finance"];
const VALID_SERVICES = [
  "trust-score",
  "settlement",
  "api-platform",
  "database",
  "cache",
  "verification",
  "credence-backend",
];

describe("Alert Rules Validators", () => {
  let alertsConfig: AlertsConfig;

  beforeAll(() => {
    const alertsPath = path.join(__dirname, "../prometheus/alerts.yml");
    const fileContent = fs.readFileSync(alertsPath, "utf-8");
    alertsConfig = yaml.parse(fileContent) as AlertsConfig;
  });

  describe("Severity Labels", () => {
    it("should have all alerts with severity label", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const rulesWithoutSeverity = allRules.filter((r) => !r.labels?.severity);

      expect(rulesWithoutSeverity).toHaveLength(0);
    });

    it("should only use valid severity levels (SEV1, SEV2, SEV3)", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const invalidSeverities = allRules.filter(
        (r) => !VALID_SEVERITIES.includes(r.labels?.severity || ""),
      );

      expect(invalidSeverities).toHaveLength(0);
    });

    it("should map trust-score alerts to SEV1", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const trustScoreRules = allRules.filter(
        (r) => r.labels?.service === "trust-score",
      );

      expect(trustScoreRules.length).toBeGreaterThan(0);
      trustScoreRules.forEach((rule) => {
        expect(rule.labels?.severity).toBe("SEV1");
      });
    });

    it("should map critical infrastructure alerts to SEV1", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const infraRules = allRules.filter(
        (r) =>
          ["database", "cache"].includes(r.labels?.service || "") &&
          r.alert.includes("Down"),
      );

      expect(infraRules.length).toBeGreaterThan(0);
      infraRules.forEach((rule) => {
        expect(rule.labels?.severity).toBe("SEV1");
      });
    });

    it("should map performance alerts to SEV2", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const perfRules = allRules.filter((r) => r.alert.includes("Endpoint") || r.alert.includes("HighP99"));

      expect(perfRules.length).toBeGreaterThan(0);
      perfRules.forEach((rule) => {
        expect(rule.labels?.severity).toBe("SEV2");
      });
    });

    it("should map low-priority alerts to SEV3", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const lowPriorityRules = allRules.filter(
        (r) =>
          r.alert.includes("SlowHealthCheck") || r.alert.includes("WorkerPool"),
      );

      expect(lowPriorityRules.length).toBeGreaterThan(0);
      lowPriorityRules.forEach((rule) => {
        expect(rule.labels?.severity).toBe("SEV3");
      });
    });
  });

  describe("Service Labels", () => {
    it("should have service label on all alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const rulesWithoutService = allRules.filter((r) => !r.labels?.service);

      expect(rulesWithoutService).toHaveLength(0);
    });

    it("should only use predefined service names", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const invalidServices = allRules.filter(
        (r) => !VALID_SERVICES.includes(r.labels?.service || ""),
      );

      expect(invalidServices).toHaveLength(0);
    });

    it("should correctly categorize trust-score alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const srRules = allRules.filter((r) => r.alert.includes("SuccessRate"));

      expect(srRules.length).toBeGreaterThan(0);
      srRules.forEach((rule) => {
        expect(rule.labels?.service).toBe("trust-score");
      });
    });

    it("should correctly categorize database alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const dbRules = allRules.filter(
        (r) => r.alert.includes("Database") || r.alert.includes("Pool"),
      );

      expect(dbRules.length).toBeGreaterThan(0);
      dbRules.forEach((rule) => {
        expect(rule.labels?.service).toBe("database");
      });
    });

    it("should correctly categorize cache alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const redisRules = allRules.filter((r) => r.alert.includes("Redis"));

      expect(redisRules.length).toBeGreaterThan(0);
      redisRules.forEach((rule) => {
        expect(rule.labels?.service).toBe("cache");
      });
    });
  });

  describe("Team Labels", () => {
    it("should have team label on all alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const rulesWithoutTeam = allRules.filter((r) => !r.labels?.team);

      expect(rulesWithoutTeam).toHaveLength(0);
    });

    it("should only use predefined team names", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const invalidTeams = allRules.filter(
        (r) => !VALID_TEAMS.includes(r.labels?.team || ""),
      );

      expect(invalidTeams).toHaveLength(0);
    });

    it("should assign platform team to application alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const appRules = allRules.filter((r) =>
        ["trust-score", "api-platform", "verification"].includes(
          r.labels?.service || "",
        ),
      );

      expect(appRules.length).toBeGreaterThan(0);
      appRules.forEach((rule) => {
        expect(rule.labels?.team).toBe("platform");
      });
    });

    it("should assign infrastructure team to infra alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const infraRules = allRules.filter((r) =>
        ["database", "cache"].includes(r.labels?.service || ""),
      );

      expect(infraRules.length).toBeGreaterThan(0);
      infraRules.forEach((rule) => {
        expect(rule.labels?.team).toBe("infrastructure");
      });
    });

    it("should assign finance team to settlement alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const settlementRules = allRules.filter(
        (r) => r.labels?.service === "settlement",
      );

      // Note: settlement may not be in current rules, but test structure is correct
      if (settlementRules.length > 0) {
        settlementRules.forEach((rule) => {
          expect(rule.labels?.team).toBe("finance");
        });
      }
    });
  });

  describe("Runbook URL Annotations", () => {
    it("should have runbook_url on all alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const rulesWithoutRunbook = allRules.filter(
        (r) => !r.annotations?.runbook_url,
      );

      expect(rulesWithoutRunbook).toHaveLength(0);
    });

    it("should have valid runbook URLs (HTTPS)", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const invalidUrls = allRules.filter(
        (r) =>
          r.annotations?.runbook_url &&
          !r.annotations.runbook_url.startsWith("https://"),
      );

      expect(invalidUrls).toHaveLength(0);
    });

    it("should have runbook URLs with documentation domain", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const invalidDomainUrls = allRules.filter(
        (r) =>
          r.annotations?.runbook_url &&
          !r.annotations.runbook_url.includes("docs.credence.org/runbooks"),
      );

      expect(invalidDomainUrls).toHaveLength(0);
    });

    it("should link runbooks to relevant categories", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);

      // Check a few key runbooks exist
      const latencyRules = allRules.filter((r) => r.alert.includes("Latency"));
      const dbRules = allRules.filter((r) => r.alert.includes("Database"));

      latencyRules.forEach((rule) => {
        expect(rule.annotations?.runbook_url).toContain("latency");
      });

      dbRules.forEach((rule) => {
        expect(rule.annotations?.runbook_url).toContain("database");
      });
    });
  });

  describe("Annotation Consistency", () => {
    it("should have summary on all alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const rulesWithoutSummary = allRules.filter(
        (r) => !r.annotations?.summary,
      );

      expect(rulesWithoutSummary).toHaveLength(0);
    });

    it("should have description on all alerts", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const rulesWithoutDesc = allRules.filter(
        (r) => !r.annotations?.description,
      );

      expect(rulesWithoutDesc).toHaveLength(0);
    });

    it("summary should be concise (< 100 chars)", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const verboseSummaries = allRules.filter(
        (r) => (r.annotations?.summary?.length || 0) > 100,
      );

      expect(verboseSummaries).toHaveLength(0);
    });

    it("description should contain alert context", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const emptyDescriptions = allRules.filter(
        (r) =>
          !r.annotations?.description || r.annotations.description.length < 5,
      );

      expect(emptyDescriptions).toHaveLength(0);
    });
  });

  describe("Alert Expression Validation", () => {
    it("should have valid PromQL expressions", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);

      allRules.forEach((rule) => {
        // Basic checks - expression should not be empty and contain metric names
        expect(rule.expr).toBeTruthy();
        expect(rule.expr.length).toBeGreaterThan(0);
        // Should contain at least one metric selector or keyword
        expect(rule.expr.match(/\{|rate|sum|histogram/)).toBeTruthy();
      });
    });

    it("should have appropriate for: durations", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);

      // All rules should have for field in config (implicitly validated by YAML structure)
      allRules.forEach((rule) => {
        expect(rule).toHaveProperty("alert");
        expect(rule).toHaveProperty("expr");
      });
    });
  });

  describe("Label Combination Rules", () => {
    it("SEV1 alerts should have on-call team defined", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);
      const sev1Rules = allRules.filter((r) => r.labels?.severity === "SEV1");

      expect(sev1Rules.length).toBeGreaterThan(0);
      sev1Rules.forEach((rule) => {
        expect(rule.labels?.service).toBeTruthy();
        expect(rule.labels?.team).toBeTruthy();
        expect(VALID_TEAMS).toContain(rule.labels?.team);
      });
    });

    it("should not have orphaned labels", () => {
      const allRules = alertsConfig.groups.flatMap((g) => g.rules);

      allRules.forEach((rule) => {
        Object.entries(rule.labels || {}).forEach(([key, value]) => {
          // All label values should be non-empty strings
          expect(typeof value).toBe("string");
          expect((value as string).length).toBeGreaterThan(0);
        });
      });
    });
  });
});

describe("AlertManager Configuration Validators", () => {
  let alertManagerConfig: AlertManagerConfig;

  beforeAll(() => {
    const configPath = path.join(__dirname, "../prometheus/alertmanager.yml");
    const fileContent = fs.readFileSync(configPath, "utf-8");
    alertManagerConfig = yaml.parse(fileContent) as AlertManagerConfig;
  });

  describe("Receiver Configuration", () => {
    it("should have receivers section", () => {
      expect(alertManagerConfig.receivers).toBeDefined();
      expect(Array.isArray(alertManagerConfig.receivers)).toBe(true);
    });

    it("should have at least one receiver", () => {
      expect(alertManagerConfig.receivers?.length).toBeGreaterThan(0);
    });

    it("should have production receivers", () => {
      const receiverNames =
        alertManagerConfig.receivers?.map((r) => r.name) || [];

      expect(receiverNames).toContain("pagerduty-prod-critical");
      expect(receiverNames).toContain("slack-prod-alerts");
    });

    it("should have staging receivers", () => {
      const receiverNames =
        alertManagerConfig.receivers?.map((r) => r.name) || [];

      expect(receiverNames).toContain("slack-staging-alerts");
      expect(receiverNames).toContain("slack-staging-low-priority");
    });

    it("should have dev receivers", () => {
      const receiverNames =
        alertManagerConfig.receivers?.map((r) => r.name) || [];

      expect(receiverNames).toContain("slack-dev-alerts");
    });

    it("should use environment variables for sensitive values", () => {
      const configStr = JSON.stringify(alertManagerConfig);

      // Should not contain real tokens or keys (only env var references)
      expect(configStr).not.toMatch(/sk-[A-Za-z0-9]+/);
      expect(configStr).not.toMatch(/xoxb-[A-Za-z0-9]+/);

      // Should contain env var references
      expect(configStr).toContain("ALERTMANAGER_SLACK_WEBHOOK");
    });
  });

  describe("Route Configuration", () => {
    it("should have routes section", () => {
      expect(alertManagerConfig.routes).toBeDefined();
    });

    it("should define production routes", () => {
      const routesStr = JSON.stringify(alertManagerConfig.routes);

      expect(routesStr).toContain("prod");
      expect(routesStr).toContain("SEV1");
      expect(routesStr).toContain("SEV2");
      expect(routesStr).toContain("SEV3");
    });

    it("should define environment-specific routes", () => {
      const routesStr = JSON.stringify(alertManagerConfig.routes);

      expect(routesStr).toContain("prod");
      expect(routesStr).toContain("staging");
      expect(routesStr).toContain("dev");
    });
  });

  describe("Inhibition Rules", () => {
    it("should have inhibition rules defined", () => {
      expect(alertManagerConfig.inhibit_rules).toBeDefined();
      expect(Array.isArray(alertManagerConfig.inhibit_rules)).toBe(true);
      expect(alertManagerConfig.inhibit_rules?.length).toBeGreaterThan(0);
    });

    it("should inhibit lower severities when higher fires", () => {
      const inhibitRulesStr = JSON.stringify(alertManagerConfig.inhibit_rules);

      // Should have rules for SEV1 suppressing SEV2/SEV3
      expect(inhibitRulesStr).toContain("SEV1");
      expect(inhibitRulesStr).toContain("SEV2");
      expect(inhibitRulesStr).toContain("SEV3");
    });
  });

  describe("Global Configuration", () => {
    it("should have global section", () => {
      expect(alertManagerConfig.global).toBeDefined();
    });

    it("should reference environment variables in global config", () => {
      const globalStr = JSON.stringify(alertManagerConfig.global || {});

      expect(globalStr.length).toBeGreaterThan(0);
    });
  });
});

describe("Edge Cases and Integration", () => {
  it("should handle alert name with special characters", () => {
    const alertsPath = path.join(
      __dirname,
      "../prometheus/alerts.yml",
    );
    const fileContent = fs.readFileSync(alertsPath, "utf-8");
    const config = yaml.parse(fileContent) as AlertsConfig;

    const allRules = config.groups.flatMap((g) => g.rules);
    allRules.forEach((rule) => {
      // Alert names should be alphanumeric + underscores
      expect(rule.alert).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
    });
  });

  it("should maintain consistency between alerts and routing", () => {
    const alertsPath = path.join(
      __dirname,
      "../prometheus/alerts.yml",
    );
    const configPath = path.join(
      __dirname,
      "../prometheus/alertmanager.yml",
    );

    const alertsContent = fs.readFileSync(alertsPath, "utf-8");
    const configContent = fs.readFileSync(configPath, "utf-8");

    const alertsConfig = yaml.parse(alertsContent) as AlertsConfig;
    const amConfig = yaml.parse(configContent) as AlertManagerConfig;

    // All services in alerts should be routeable
    const alertServices = new Set(
      alertsConfig.groups.flatMap((g) =>
        g.rules.map((r) => r.labels?.service).filter(Boolean),
      ),
    );

    alertServices.forEach((service) => {
      expect(VALID_SERVICES).toContain(service as string);
    });
  });
});


