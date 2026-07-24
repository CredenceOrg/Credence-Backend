/**
 * Policy evaluator – the core of the fine-grained authorization engine.
 *
 * Evaluation algorithm (deny-by-default):
 *  1. Collect all rules for the org (including platform-wide '*' rules).
 *  2. Filter to rules whose subject, action, and resource match the context.
 *  3. If any matching rule has effect 'deny'  → DENY  (deny wins).
 *  4. If any matching rule has effect 'allow' → ALLOW.
 *  5. Otherwise fall back to the caller's global role via ROLE_HIERARCHY.
 *  6. If no rule and no role fallback matches  → DENY.
 */

import { ROLE_HIERARCHY } from '../../types/rbac.js'
import type { PolicyContext, PolicyDecision, PolicyRule } from './types.js'
import type { PolicyStore } from './store.js'

// Roles that implicitly allow everything (fallback when no explicit rule exists)
const ADMIN_ROLE_WEIGHT = ROLE_HIERARCHY['admin']

export class PolicyEvaluator {
  constructor(private store: PolicyStore) {}

  evaluate(ctx: PolicyContext): PolicyDecision {
    const rules = this.store.findAllByOrg(ctx.orgId)
    const matching = rules.filter((r) => this.matches(r, ctx))

    // Explicit deny wins over everything
    const denyRule = matching.find((r) => r.effect === 'deny')
    if (denyRule) {
      return {
        allowed: false,
        reason: `Explicit deny rule matched (id=${denyRule.id})`,
        matchedRule: denyRule,
      }
    }

    // Explicit allow
    const allowRule = matching.find((r) => r.effect === 'allow')
    if (allowRule) {
      return {
        allowed: true,
        reason: `Explicit allow rule matched (id=${allowRule.id})`,
        matchedRule: allowRule,
      }
    }

    // Fallback: platform admins are implicitly allowed when no rule exists
    if (ROLE_HIERARCHY[ctx.role] >= ADMIN_ROLE_WEIGHT) {
      return {
        allowed: true,
        reason: 'Fallback: caller has admin role',
      }
    }

    return {
      allowed: false,
      reason: 'Deny by default: no matching allow rule found',
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private matches(rule: PolicyRule, ctx: PolicyContext): boolean {
    return (
      this.subjectMatches(rule.subject, ctx) &&
      this.actionMatches(rule.action, ctx.action) &&
      this.resourceMatches(rule.resource, ctx.resource) &&
      this.conditionsMatch(rule.conditions, ctx.extra)
    )
  }

  private subjectMatches(subject: string, ctx: PolicyContext): boolean {
    if (subject === '*') return true
    if (subject === `user:${ctx.userId}`) return true
    // Subject is a role name
    if (subject === ctx.role) return true
    // Hierarchical role match: rule grants to 'user', caller is 'verifier' or 'admin'
    const subjectWeight = ROLE_HIERARCHY[subject as keyof typeof ROLE_HIERARCHY]
    if (subjectWeight !== undefined) {
      return ROLE_HIERARCHY[ctx.role] >= subjectWeight
    }
    return false
  }

  private actionMatches(ruleAction: string, ctxAction: string): boolean {
    return ruleAction === '*' || ruleAction === ctxAction
  }

  private resourceMatches(ruleResource: string, ctxResource: string): boolean {
    if (ruleResource === '*') return true
    if (ruleResource === ctxResource) return true
    // Prefix wildcard: "org:acme:*" matches "org:acme:members"
    if (ruleResource.endsWith(':*')) {
      const prefix = ruleResource.slice(0, -1) // remove trailing '*'
      return ctxResource.startsWith(prefix)
    }
    return false
  }

  private conditionsMatch(
    conditions: PolicyRule['conditions'],
    extra: PolicyContext['extra'],
  ): boolean {
    if (!conditions || Object.keys(conditions).length === 0) return true
    if (!extra) return false
    return Object.entries(conditions).every(([k, v]) => extra[k] === v)
  }
}
