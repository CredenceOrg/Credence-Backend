import {
  PolicyEngine,
  PolicyDecision,
  PolicyReasonCode,
  PolicyRules,
  PolicyAuditLog,
} from "./policyEngine.js";
import { AuthenticatedUser, Role } from "../../types/rbac.js";

describe("PolicyEngine", () => {
  let engine: PolicyEngine;

  const createUser = (role: Role, id = "user-123"): AuthenticatedUser => ({
    id,
    address: `0x${id}`,
    role,
  });

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  describe("basic permission checks", () => {
    it("should deny access when no rules are defined", async () => {
      const user = createUser("user");
      const result = await engine.check(user, "read:bond", "bond:123");

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reason.code).toBe(PolicyReasonCode.NO_MATCHING_RULE);
    });

    it("should allow access when role matches exactly", async () => {
      engine.addRule({
        id: "read-bonds",
        description: "Allow users to read bonds",
        actions: ["read:bond"],
        resources: ["bond:*"],
        allowedRoles: ["user", "verifier", "admin"],
      });

      const user = createUser("user");
      const result = await engine.check(user, "read:bond", "bond:123");

      expect(result.decision).toBe(PolicyDecision.ALLOW);
      expect(result.reason.code).toBe(PolicyReasonCode.ROLE_MATCH);
    });

    it("should allow access based on role hierarchy", async () => {
      engine.addRule({
        id: "read-bonds",
        description: "Allow verifiers to read bonds",
        actions: ["read:bond"],
        resources: ["bond:*"],
        allowedRoles: ["verifier"],
      });

      // Admin has higher privilege than verifier
      const admin = createUser("admin");
      const result = await engine.check(admin, "read:bond", "bond:123");

      expect(result.decision).toBe(PolicyDecision.ALLOW);
      expect(result.reason.code).toBe(PolicyReasonCode.ROLE_HIERARCHY);
    });

    it("should deny access when role is insufficient", async () => {
      engine.addRule({
        id: "admin-only",
        description: "Admin-only action",
        actions: ["delete:*"],
        resources: ["*"],
        allowedRoles: ["admin"],
      });

      const user = createUser("user");
      const result = await engine.check(user, "delete:bond", "bond:123");

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reason.code).toBe(PolicyReasonCode.INSUFFICIENT_ROLE);
    });

    it("should allow public access when specified", async () => {
      engine.addRule({
        id: "public-health",
        description: "Public health check",
        actions: ["read:health"],
        resources: ["health"],
        allowedRoles: ["public", "user", "verifier", "admin"],
      });

      const result = await engine.check(null, "read:health", "health");

      expect(result.decision).toBe(PolicyDecision.ALLOW);
      expect(result.reason.code).toBe(PolicyReasonCode.PUBLIC_RESOURCE);
    });

    it("should deny unauthenticated access when public not allowed", async () => {
      engine.addRule({
        id: "user-only",
        description: "Authenticated users only",
        actions: ["read:profile"],
        resources: ["profile:*"],
        allowedRoles: ["user", "verifier", "admin"],
      });

      const result = await engine.check(null, "read:profile", "profile:123");

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reason.code).toBe(PolicyReasonCode.UNAUTHENTICATED);
    });
  });

  describe("wildcard matching", () => {
    it("should match wildcard actions", async () => {
      engine.addRule({
        id: "all-reads",
        description: "Allow all read operations",
        actions: ["read:*"],
        resources: ["*"],
        allowedRoles: ["user"],
      });

      const user = createUser("user");

      const result1 = await engine.check(user, "read:bond", "bond:123");
      expect(result1.decision).toBe(PolicyDecision.ALLOW);

      const result2 = await engine.check(user, "read:wallet", "wallet:456");
      expect(result2.decision).toBe(PolicyDecision.ALLOW);
    });

    it("should match wildcard resources", async () => {
      engine.addRule({
        id: "all-bonds",
        description: "Access all bonds",
        actions: ["read:bond"],
        resources: ["bond:*"],
        allowedRoles: ["verifier"],
      });

      const verifier = createUser("verifier");

      const result1 = await engine.check(verifier, "read:bond", "bond:123");
      expect(result1.decision).toBe(PolicyDecision.ALLOW);

      const result2 = await engine.check(verifier, "read:bond", "bond:999");
      expect(result2.decision).toBe(PolicyDecision.ALLOW);
    });

    it("should match full wildcards", async () => {
      engine.addRule({
        id: "admin-all",
        description: "Admin can do anything",
        actions: ["*"],
        resources: ["*"],
        allowedRoles: ["admin"],
      });

      const admin = createUser("admin");

      const result1 = await engine.check(admin, "delete:bond", "bond:123");
      expect(result1.decision).toBe(PolicyDecision.ALLOW);

      const result2 = await engine.check(admin, "write:wallet", "wallet:456");
      expect(result2.decision).toBe(PolicyDecision.ALLOW);
    });
  });

  describe("custom conditions", () => {
    it("should evaluate custom condition functions", async () => {
      engine.addRule({
        id: "owner-only",
        description: "Users can only access their own wallets",
        actions: ["read:wallet", "write:wallet"],
        resources: ["wallet:*"],
        allowedRoles: ["user"],
        condition: (user, resource) => {
          if (!user) return false;
          const walletId = resource.split(":")[1];
          return user.id === walletId;
        },
      });

      const user = createUser("user", "user-123");

      // Should allow access to own wallet
      const result1 = await engine.check(
        user,
        "read:wallet",
        "wallet:user-123",
      );
      expect(result1.decision).toBe(PolicyDecision.ALLOW);

      // Should deny access to other's wallet
      const result2 = await engine.check(
        user,
        "read:wallet",
        "wallet:user-456",
      );
      expect(result2.decision).toBe(PolicyDecision.DENY);
    });

    it("should skip rule when condition fails", async () => {
      engine.addRule({
        id: "conditional-access",
        description: "Conditional access",
        actions: ["read:*"],
        resources: ["*"],
        allowedRoles: ["user"],
        condition: () => false, // Always fails
      });

      const user = createUser("user");
      const result = await engine.check(user, "read:bond", "bond:123");

      expect(result.decision).toBe(PolicyDecision.DENY);
    });
  });

  describe("audit logging", () => {
    it("should create audit log for each decision", async () => {
      engine.addRule({
        id: "test-rule",
        description: "Test rule",
        actions: ["read:*"],
        resources: ["*"],
        allowedRoles: ["user"],
      });

      const user = createUser("user");
      await engine.check(user, "read:bond", "bond:123");

      const logs = engine.getAuditLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].user).toEqual(user);
      expect(logs[0].action).toBe("read:bond");
      expect(logs[0].resource).toBe("bond:123");
      expect(logs[0].decision).toBe(PolicyDecision.ALLOW);
    });

    it("should include metadata in audit log", async () => {
      const user = createUser("user");
      const metadata = { ip: "192.168.1.1", requestId: "req-123" };

      await engine.check(user, "read:bond", "bond:123", metadata);

      const logs = engine.getAuditLogs();
      expect(logs[0].metadata).toEqual(metadata);
    });

    it("should filter audit logs by user", async () => {
      engine.addRule({
        id: "test-rule",
        description: "Test rule",
        actions: ["*"],
        resources: ["*"],
        allowedRoles: ["user"],
      });

      const user1 = createUser("user", "user-1");
      const user2 = createUser("user", "user-2");

      await engine.check(user1, "read:bond", "bond:1");
      await engine.check(user2, "read:bond", "bond:2");
      await engine.check(user1, "read:bond", "bond:3");

      const user1Logs = engine.getAuditLogs({ userId: "user-1" });
      expect(user1Logs).toHaveLength(2);
      expect(user1Logs.every((log) => log.user?.id === "user-1")).toBe(true);
    });

    it("should filter audit logs by decision", async () => {
      engine.addRule({
        id: "admin-only",
        description: "Admin only",
        actions: ["delete:*"],
        resources: ["*"],
        allowedRoles: ["admin"],
      });

      const user = createUser("user");
      const admin = createUser("admin");

      await engine.check(user, "delete:bond", "bond:1"); // Deny
      await engine.check(admin, "delete:bond", "bond:2"); // Allow
      await engine.check(user, "delete:bond", "bond:3"); // Deny

      const deniedLogs = engine.getAuditLogs({ decision: PolicyDecision.DENY });
      expect(deniedLogs).toHaveLength(2);

      const allowedLogs = engine.getAuditLogs({
        decision: PolicyDecision.ALLOW,
      });
      expect(allowedLogs).toHaveLength(1);
    });

    it("should filter audit logs by time", async () => {
      const user = createUser("user");
      const beforeTime = new Date();

      await new Promise((resolve) => setTimeout(resolve, 10));

      await engine.check(user, "read:bond", "bond:1");

      const recentLogs = engine.getAuditLogs({ since: beforeTime });
      expect(recentLogs).toHaveLength(1);
    });

    it("should invoke audit callback", async () => {
      const auditLogs: PolicyAuditLog[] = [];
      engine.onAudit((log) => {
        auditLogs.push(log);
      });

      const user = createUser("user");
      await engine.check(user, "read:bond", "bond:123");

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].action).toBe("read:bond");
    });

    it("should support async audit callback", async () => {
      const auditLogs: PolicyAuditLog[] = [];
      engine.onAudit(async (log) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        auditLogs.push(log);
      });

      const user = createUser("user");
      await engine.check(user, "read:bond", "bond:123");

      expect(auditLogs).toHaveLength(1);
    });
  });

  describe("rule management", () => {
    it("should add and retrieve rules", async () => {
      const rule = {
        id: "test-rule",
        description: "Test rule",
        actions: ["read:*"],
        resources: ["*"],
        allowedRoles: ["user"] as Role[],
      };

      engine.addRule(rule);

      const rules = engine.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual(rule);
    });

    it("should remove rules by ID", async () => {
      engine.addRule({
        id: "rule-1",
        description: "Rule 1",
        actions: ["*"],
        resources: ["*"],
        allowedRoles: ["user"],
      });

      engine.addRule({
        id: "rule-2",
        description: "Rule 2",
        actions: ["*"],
        resources: ["*"],
        allowedRoles: ["admin"],
      });

      const removed = engine.removeRule("rule-1");
      expect(removed).toBe(true);

      const rules = engine.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("rule-2");
    });

    it("should return false when removing non-existent rule", async () => {
      const removed = engine.removeRule("non-existent");
      expect(removed).toBe(false);
    });

    it("should clear all rules", async () => {
      engine.addRule({
        id: "rule-1",
        description: "Rule 1",
        actions: ["*"],
        resources: ["*"],
        allowedRoles: ["user"],
      });

      engine.clearRules();

      const rules = engine.getRules();
      expect(rules).toHaveLength(0);
    });
  });

  describe("PolicyRules helpers", () => {
    it("should create public read rule", async () => {
      const rule = PolicyRules.publicRead("health");
      engine.addRule(rule);

      const result = await engine.check(null, "read:health", "health");
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });

    it("should create minimum role rule", async () => {
      const rule = PolicyRules.requireMinRole(
        "read:bond",
        "bond:*",
        "verifier",
      );
      engine.addRule(rule);

      const user = createUser("user");
      const verifier = createUser("verifier");
      const admin = createUser("admin");

      const userResult = await engine.check(user, "read:bond", "bond:123");
      expect(userResult.decision).toBe(PolicyDecision.DENY);

      const verifierResult = await engine.check(
        verifier,
        "read:bond",
        "bond:123",
      );
      expect(verifierResult.decision).toBe(PolicyDecision.ALLOW);

      const adminResult = await engine.check(admin, "read:bond", "bond:123");
      expect(adminResult.decision).toBe(PolicyDecision.ALLOW);
    });

    it("should create admin-only rule", async () => {
      const rule = PolicyRules.adminOnly("delete:*", "*");
      engine.addRule(rule);

      const user = createUser("user");
      const admin = createUser("admin");

      const userResult = await engine.check(user, "delete:bond", "bond:123");
      expect(userResult.decision).toBe(PolicyDecision.DENY);

      const adminResult = await engine.check(admin, "delete:bond", "bond:123");
      expect(adminResult.decision).toBe(PolicyDecision.ALLOW);
    });

    it("should create owner-only rule", async () => {
      const rule = PolicyRules.ownerOnly(
        "write:wallet",
        "wallet:*",
        (resource) => resource.split(":")[1],
      );
      engine.addRule(rule);

      const owner = createUser("user", "user-123");
      const other = createUser("user", "user-456");

      const ownerResult = await engine.check(
        owner,
        "write:wallet",
        "wallet:user-123",
      );
      expect(ownerResult.decision).toBe(PolicyDecision.ALLOW);

      const otherResult = await engine.check(
        other,
        "write:wallet",
        "wallet:user-123",
      );
      expect(otherResult.decision).toBe(PolicyDecision.DENY);
    });
  });

  describe("complex scenarios", () => {
    it("should handle multiple overlapping rules", async () => {
      engine.addRule({
        id: "user-read",
        description: "Users can read",
        actions: ["read:*"],
        resources: ["*"],
        allowedRoles: ["user"],
      });

      engine.addRule({
        id: "verifier-write",
        description: "Verifiers can write",
        actions: ["write:*"],
        resources: ["*"],
        allowedRoles: ["verifier"],
      });

      const user = createUser("user");
      const verifier = createUser("verifier");

      const userRead = await engine.check(user, "read:bond", "bond:123");
      expect(userRead.decision).toBe(PolicyDecision.ALLOW);

      const userWrite = await engine.check(user, "write:bond", "bond:123");
      expect(userWrite.decision).toBe(PolicyDecision.DENY);

      const verifierRead = await engine.check(
        verifier,
        "read:bond",
        "bond:123",
      );
      expect(verifierRead.decision).toBe(PolicyDecision.ALLOW); // Hierarchy

      const verifierWrite = await engine.check(
        verifier,
        "write:bond",
        "bond:123",
      );
      expect(verifierWrite.decision).toBe(PolicyDecision.ALLOW);
    });

    it("should handle resource-specific permissions", async () => {
      engine.addRule({
        id: "read-bonds",
        description: "Read bonds",
        actions: ["read:bond"],
        resources: ["bond:*"],
        allowedRoles: ["user"],
      });

      engine.addRule({
        id: "read-wallets",
        description: "Read wallets",
        actions: ["read:wallet"],
        resources: ["wallet:*"],
        allowedRoles: ["verifier"],
      });

      const user = createUser("user");

      const bondResult = await engine.check(user, "read:bond", "bond:123");
      expect(bondResult.decision).toBe(PolicyDecision.ALLOW);

      const walletResult = await engine.check(
        user,
        "read:wallet",
        "wallet:456",
      );
      expect(walletResult.decision).toBe(PolicyDecision.DENY);
    });
  });
});
