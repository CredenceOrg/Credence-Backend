import { PermissionDecision } from "../schemas/rbac.js";

type PolicyRule = {
  role: string;
  resource: string;
  action: string;
  effect: "allow" | "deny";
};

// Some default policies for the engine
const defaultPolicies: PolicyRule[] = [
  { role: "admin", resource: "*", action: "*", effect: "allow" },
  { role: "user", resource: "profile", action: "read", effect: "allow" },
  { role: "user", resource: "profile", action: "update", effect: "allow" },
  { role: "guest", resource: "public", action: "read", effect: "allow" },
];

export class RbacPolicyEngine {
  private policies: PolicyRule[];

  constructor(policies: PolicyRule[] = defaultPolicies) {
    this.policies = policies;
  }

  /**
   * Evaluate a permission check request and return an auditable decision.
   */
  public evaluate(roles: string[], action: string, resource: string, context?: Record<string, any>): PermissionDecision {
    const timestamp = new Date().toISOString();

    // Check deny rules first (explicit deny overrides allow)
    for (const role of roles) {
      const matchedDeny = this.policies.find(p => 
        this.match(p.role, role) &&
        this.match(p.resource, resource) &&
        this.match(p.action, action) &&
        p.effect === "deny"
      );

      if (matchedDeny) {
        return {
          allowed: false,
          reason: "Explicit deny rule matched",
          ruleMatched: JSON.stringify(matchedDeny),
          timestamp,
          context: { roles, action, resource, ...context }
        };
      }
    }

    // Check allow rules
    for (const role of roles) {
      const matchedAllow = this.policies.find(p => 
        this.match(p.role, role) &&
        this.match(p.resource, resource) &&
        this.match(p.action, action) &&
        p.effect === "allow"
      );

      if (matchedAllow) {
        return {
          allowed: true,
          reason: "Explicit allow rule matched",
          ruleMatched: JSON.stringify(matchedAllow),
          timestamp,
          context: { roles, action, resource, ...context }
        };
      }
    }

    // Default deny
    return {
      allowed: false,
      reason: "No matching allow rule found (default deny)",
      timestamp,
      context: { roles, action, resource, ...context }
    };
  }

  private match(pattern: string, value: string): boolean {
    if (pattern === "*") return true;
    return pattern === value;
  }
}

export const rbacEngine = new RbacPolicyEngine();
