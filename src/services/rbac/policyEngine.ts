import { Role, ROLE_HIERARCHY, AuthenticatedUser } from "../../types/rbac.js";

/**
 * Result of a permission check.
 */
export enum PolicyDecision {
  ALLOW = "allow",
  DENY = "deny",
}

/**
 * Reason for a policy decision.
 */
export interface PolicyReason {
  /** Human-readable explanation of the decision. */
  message: string;
  /** Machine-readable reason code. */
  code: string;
  /** Additional context for debugging. */
  context?: Record<string, any>;
}

/**
 * Complete audit record of a permission check.
 */
export interface PolicyAuditLog {
  /** Unique identifier for this decision. */
  id: string;
  /** Timestamp when the decision was made. */
  timestamp: Date;
  /** The user who requested the action. */
  user: AuthenticatedUser | null;
  /** The action being attempted (e.g., 'read:bond', 'write:wallet'). */
  action: string;
  /** The resource being accessed (e.g., 'bond:123', 'wallet:0xABC'). */
  resource: string;
  /** The final decision. */
  decision: PolicyDecision;
  /** Explanation for the decision. */
  reason: PolicyReason;
  /** Additional metadata (e.g., IP address, request ID). */
  metadata?: Record<string, any>;
}

/**
 * Policy rule for permission checks.
 */
export interface PolicyRule {
  /** Unique identifier for this rule. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Actions this rule applies to (supports wildcards). */
  actions: string[];
  /** Resources this rule applies to (supports wildcards). */
  resources: string[];
  /** Roles that are allowed by this rule. */
  allowedRoles: Role[];
  /** Optional custom condition function. */
  condition?: (user: AuthenticatedUser | null, resource: string) => boolean;
}

/**
 * Reason codes for policy decisions.
 */
export const PolicyReasonCode = {
  // Allow reasons
  ROLE_MATCH: "role_match",
  ROLE_HIERARCHY: "role_hierarchy",
  PUBLIC_RESOURCE: "public_resource",
  CUSTOM_CONDITION: "custom_condition",

  // Deny reasons
  UNAUTHENTICATED: "unauthenticated",
  INSUFFICIENT_ROLE: "insufficient_role",
  NO_MATCHING_RULE: "no_matching_rule",
  CUSTOM_CONDITION_FAILED: "custom_condition_failed",
  EXPLICIT_DENY: "explicit_deny",
} as const;

/**
 * RBAC Policy Engine with auditable allow/deny decisions.
 *
 * Features:
 * - Fine-grained permission checks based on action + resource
 * - Role hierarchy support (admin > verifier > user > public)
 * - Wildcard matching for actions and resources
 * - Custom condition functions for complex rules
 * - Complete audit trail of all decisions
 * - Explicit allow/deny with detailed reasoning
 */
export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private auditLogs: PolicyAuditLog[] = [];
  private auditCallback?: (log: PolicyAuditLog) => void | Promise<void>;

  /**
   * Register a callback to be invoked for each policy decision.
   * Useful for persisting audit logs to a database or external system.
   */
  onAudit(callback: (log: PolicyAuditLog) => void | Promise<void>): void {
    this.auditCallback = callback;
  }

  /**
   * Add a policy rule to the engine.
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  /**
   * Remove a policy rule by ID.
   */
  removeRule(ruleId: string): boolean {
    const initialLength = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== ruleId);
    return this.rules.length < initialLength;
  }

  /**
   * Get all registered rules.
   */
  getRules(): readonly PolicyRule[] {
    return [...this.rules];
  }

  /**
   * Clear all rules (useful for testing).
   */
  clearRules(): void {
    this.rules = [];
  }

  /**
   * Check if a user is allowed to perform an action on a resource.
   *
   * @param user     - The authenticated user (or null for anonymous).
   * @param action   - The action being attempted (e.g., 'read:bond', 'write:wallet').
   * @param resource - The resource being accessed (e.g., 'bond:123', 'wallet:0xABC').
   * @param metadata - Optional metadata to include in the audit log.
   * @returns The policy decision with detailed reasoning.
   */
  async check(
    user: AuthenticatedUser | null,
    action: string,
    resource: string,
    metadata?: Record<string, any>,
  ): Promise<PolicyAuditLog> {
    const id = this.generateId();
    const timestamp = new Date();

    // Find matching rules
    const matchingRules = this.rules.filter((rule) =>
      this.ruleMatches(rule, action, resource),
    );

    let decision: PolicyDecision;
    let reason: PolicyReason;

    if (matchingRules.length === 0) {
      // No matching rule found - default deny
      decision = PolicyDecision.DENY;
      reason = {
        message: `No policy rule matches action "${action}" on resource "${resource}"`,
        code: PolicyReasonCode.NO_MATCHING_RULE,
        context: { action, resource },
      };
    } else {
      // Evaluate matching rules
      const evaluation = this.evaluateRules(matchingRules, user, resource);
      decision = evaluation.decision;
      reason = evaluation.reason;
    }

    // Create audit log
    const auditLog: PolicyAuditLog = {
      id,
      timestamp,
      user,
      action,
      resource,
      decision,
      reason,
      metadata,
    };

    // Store audit log
    this.auditLogs.push(auditLog);

    // Invoke callback if registered
    if (this.auditCallback) {
      await this.auditCallback(auditLog);
    }

    return auditLog;
  }

  /**
   * Get all audit logs, optionally filtered.
   */
  getAuditLogs(filter?: {
    userId?: string;
    action?: string;
    resource?: string;
    decision?: PolicyDecision;
    since?: Date;
  }): PolicyAuditLog[] {
    let logs = [...this.auditLogs];

    if (filter) {
      if (filter.userId) {
        logs = logs.filter((log) => log.user?.id === filter.userId);
      }
      if (filter.action) {
        logs = logs.filter((log) => log.action === filter.action);
      }
      if (filter.resource) {
        logs = logs.filter((log) => log.resource === filter.resource);
      }
      if (filter.decision) {
        logs = logs.filter((log) => log.decision === filter.decision);
      }
      if (filter.since) {
        logs = logs.filter((log) => log.timestamp >= filter.since!);
      }
    }

    return logs;
  }

  /**
   * Clear all audit logs (useful for testing).
   */
  clearAuditLogs(): void {
    this.auditLogs = [];
  }

  /**
   * Check if a rule matches the given action and resource.
   */
  private ruleMatches(
    rule: PolicyRule,
    action: string,
    resource: string,
  ): boolean {
    const actionMatches = rule.actions.some((pattern) =>
      this.wildcardMatch(pattern, action),
    );
    const resourceMatches = rule.resources.some((pattern) =>
      this.wildcardMatch(pattern, resource),
    );
    return actionMatches && resourceMatches;
  }

  /**
   * Evaluate matching rules and return a decision.
   */
  private evaluateRules(
    rules: PolicyRule[],
    user: AuthenticatedUser | null,
    resource: string,
  ): { decision: PolicyDecision; reason: PolicyReason } {
    // If user is not authenticated, check if any rule allows public access
    if (!user) {
      const publicRule = rules.find((rule) =>
        rule.allowedRoles.includes("public"),
      );

      if (publicRule) {
        return {
          decision: PolicyDecision.ALLOW,
          reason: {
            message: `Public access allowed by rule "${publicRule.id}"`,
            code: PolicyReasonCode.PUBLIC_RESOURCE,
            context: { ruleId: publicRule.id },
          },
        };
      }

      return {
        decision: PolicyDecision.DENY,
        reason: {
          message: "Authentication required",
          code: PolicyReasonCode.UNAUTHENTICATED,
        },
      };
    }

    // Check each rule in order
    for (const rule of rules) {
      // Check if user's role is in the allowed roles
      if (rule.allowedRoles.includes(user.role)) {
        // Check custom condition if present
        if (rule.condition && !rule.condition(user, resource)) {
          continue;
        }

        return {
          decision: PolicyDecision.ALLOW,
          reason: {
            message: `Role "${user.role}" allowed by rule "${rule.id}"`,
            code: PolicyReasonCode.ROLE_MATCH,
            context: { ruleId: rule.id, role: user.role },
          },
        };
      }

      // Check if user's role satisfies hierarchy requirement
      const minRequiredRole = this.getMinRole(rule.allowedRoles);
      if (
        minRequiredRole &&
        ROLE_HIERARCHY[user.role] >= ROLE_HIERARCHY[minRequiredRole]
      ) {
        // Check custom condition if present
        if (rule.condition && !rule.condition(user, resource)) {
          continue;
        }

        return {
          decision: PolicyDecision.ALLOW,
          reason: {
            message: `Role "${user.role}" satisfies minimum role "${minRequiredRole}" by hierarchy`,
            code: PolicyReasonCode.ROLE_HIERARCHY,
            context: {
              ruleId: rule.id,
              userRole: user.role,
              minRequiredRole,
            },
          },
        };
      }
    }

    // No rule allowed access
    return {
      decision: PolicyDecision.DENY,
      reason: {
        message: `Role "${user.role}" does not satisfy any matching policy rule`,
        code: PolicyReasonCode.INSUFFICIENT_ROLE,
        context: { role: user.role },
      },
    };
  }

  /**
   * Get the minimum (least privileged) role from a list.
   */
  private getMinRole(roles: Role[]): Role | null {
    if (roles.length === 0) return null;

    return roles.reduce((min, role) =>
      ROLE_HIERARCHY[role] < ROLE_HIERARCHY[min] ? role : min,
    );
  }

  /**
   * Simple wildcard matching (* matches any sequence of characters).
   */
  private wildcardMatch(pattern: string, value: string): boolean {
    if (pattern === "*") return true;

    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(value);
  }

  /**
   * Generate a unique ID for audit logs.
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Default policy engine instance.
 */
export const policyEngine = new PolicyEngine();

/**
 * Helper to create common policy rules.
 */
export const PolicyRules = {
  /**
   * Allow public read access to a resource.
   */
  publicRead(resourcePattern: string): PolicyRule {
    return {
      id: `public-read-${resourcePattern}`,
      description: `Allow public read access to ${resourcePattern}`,
      actions: ["read:*"],
      resources: [resourcePattern],
      allowedRoles: ["public", "user", "verifier", "admin"],
    };
  },

  /**
   * Require minimum role for an action.
   */
  requireMinRole(
    actionPattern: string,
    resourcePattern: string,
    minRole: Role,
  ): PolicyRule {
    const allowedRoles: Role[] = [];
    for (const [role, level] of Object.entries(ROLE_HIERARCHY)) {
      if (level >= ROLE_HIERARCHY[minRole]) {
        allowedRoles.push(role as Role);
      }
    }

    return {
      id: `min-role-${minRole}-${actionPattern}-${resourcePattern}`,
      description: `Require minimum role "${minRole}" for ${actionPattern} on ${resourcePattern}`,
      actions: [actionPattern],
      resources: [resourcePattern],
      allowedRoles,
    };
  },

  /**
   * Admin-only access.
   */
  adminOnly(actionPattern: string, resourcePattern: string): PolicyRule {
    return {
      id: `admin-only-${actionPattern}-${resourcePattern}`,
      description: `Admin-only access for ${actionPattern} on ${resourcePattern}`,
      actions: [actionPattern],
      resources: [resourcePattern],
      allowedRoles: ["admin"],
    };
  },

  /**
   * Resource owner access (user can only access their own resources).
   */
  ownerOnly(
    actionPattern: string,
    resourcePattern: string,
    extractOwnerId: (resource: string) => string,
  ): PolicyRule {
    return {
      id: `owner-only-${actionPattern}-${resourcePattern}`,
      description: `Owner-only access for ${actionPattern} on ${resourcePattern}`,
      actions: [actionPattern],
      resources: [resourcePattern],
      allowedRoles: ["user", "verifier", "admin"],
      condition: (user, resource) => {
        if (!user) return false;
        const ownerId = extractOwnerId(resource);
        return user.id === ownerId || user.address === ownerId;
      },
    };
  },
};
