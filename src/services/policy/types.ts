/**
 * Fine-grained policy engine types.
 *
 * A policy rule maps (action, resource, optional context conditions) → effect.
 * Evaluation is deny-by-default: a request is allowed only when at least one
 * Allow rule matches AND no Deny rule matches.
 */

/** Coarse roles that already exist in the system. */
export type Role = 'admin' | 'verifier' | 'user' | 'public'

/** Effect of a matched rule. */
export type PolicyEffect = 'allow' | 'deny'

/**
 * Actions that can be performed on org resources.
 * Extend this union as new capabilities are added.
 */
export type PolicyAction =
  | 'org:read'
  | 'org:update'
  | 'org:delete'
  | 'org:member:invite'
  | 'org:member:remove'
  | 'org:member:list'
  | 'org:role:assign'
  | 'org:apikey:create'
  | 'org:apikey:revoke'
  | 'org:apikey:list'
  | 'org:audit:read'
  | 'org:policy:read'
  | 'org:policy:write'
  | '*' // wildcard – matches any action

/**
 * Resources that policies can target.
 * Use `*` to match any resource within the org.
 */
export type PolicyResource = string // e.g. "org:acme", "org:acme:members", "*"

/**
 * Optional context conditions that must ALL be true for the rule to match.
 * Keys are context field names; values are the required values.
 */
export type PolicyConditions = Record<string, string | boolean | number>

/** A single policy rule stored in the policy store. */
export interface PolicyRule {
  id: string
  /** Org this rule belongs to. `*` means platform-wide. */
  orgId: string
  /** Subject: a role name or a specific user ID prefixed with "user:". */
  subject: string
  action: PolicyAction
  resource: PolicyResource
  effect: PolicyEffect
  conditions?: PolicyConditions
  createdAt: string
  updatedAt: string
}

/** Input for creating a new rule (id and timestamps are generated). */
export type CreatePolicyRuleInput = Omit<PolicyRule, 'id' | 'createdAt' | 'updatedAt'>

/** Context passed to the evaluator at request time. */
export interface PolicyContext {
  /** Requesting user's ID. */
  userId: string
  /** Requesting user's global role. */
  role: Role
  /** Organisation being accessed. */
  orgId: string
  /** Action being attempted. */
  action: PolicyAction
  /** Resource being accessed. */
  resource: PolicyResource
  /** Arbitrary key/value pairs for condition matching. */
  extra?: Record<string, string | boolean | number>
}

/** Result returned by the evaluator. */
export interface PolicyDecision {
  allowed: boolean
  /** Human-readable reason (useful for audit logs and debugging). */
  reason: string
  /** The matching rule that determined the outcome, if any. */
  matchedRule?: PolicyRule
}
