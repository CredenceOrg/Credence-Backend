/**
 * PolicyService – public API for the policy engine.
 *
 * Wraps the evaluator and store, emits audit entries for every policy
 * mutation, and exposes a single `authorize` method for use in middleware.
 */

import { AuditLogService, AuditAction } from '../audit/index.js'
import { PolicyEvaluator } from './evaluator.js'
import { policyStore, PolicyStore } from './store.js'
import type {
  CreatePolicyRuleInput,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
} from './types.js'

export class PolicyService {
  private evaluator: PolicyEvaluator

  constructor(
    private store: PolicyStore,
    private audit: AuditLogService,
  ) {
    this.evaluator = new PolicyEvaluator(store)
  }

  // ---------------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------------

  /**
   * Evaluate whether the caller described by `ctx` is permitted to proceed.
   * This is the primary entry point for middleware integration.
   */
  authorize(ctx: PolicyContext): PolicyDecision {
    return this.evaluator.evaluate(ctx)
  }

  // ---------------------------------------------------------------------------
  // Rule management (mutations emit audit entries)
  // ---------------------------------------------------------------------------

  createRule(
    actorId: string,
    actorEmail: string,
    input: CreatePolicyRuleInput,
  ): PolicyRule {
    const rule = this.store.create(input)
    this.audit.logAction(
      actorId,
      actorEmail,
      AuditAction.POLICY_RULE_CREATED,
      actorId,
      actorEmail,
      { ruleId: rule.id, orgId: rule.orgId, subject: rule.subject, action: rule.action, effect: rule.effect },
    )
    return rule
  }

  updateRule(
    actorId: string,
    actorEmail: string,
    ruleId: string,
    patch: Partial<Omit<PolicyRule, 'id' | 'createdAt'>>,
  ): PolicyRule {
    const updated = this.store.update(ruleId, patch)
    if (!updated) throw new Error(`Policy rule not found: ${ruleId}`)
    this.audit.logAction(
      actorId,
      actorEmail,
      AuditAction.POLICY_RULE_UPDATED,
      actorId,
      actorEmail,
      { ruleId, patch },
    )
    return updated
  }

  deleteRule(actorId: string, actorEmail: string, ruleId: string): void {
    const rule = this.store.findById(ruleId)
    if (!rule) throw new Error(`Policy rule not found: ${ruleId}`)
    this.store.delete(ruleId)
    this.audit.logAction(
      actorId,
      actorEmail,
      AuditAction.POLICY_RULE_DELETED,
      actorId,
      actorEmail,
      { ruleId, orgId: rule.orgId },
    )
  }

  listRules(orgId: string): PolicyRule[] {
    return this.store.findByOrg(orgId)
  }

  getRule(ruleId: string): PolicyRule | null {
    return this.store.findById(ruleId)
  }
}

// Singleton wired to the shared audit service
import { auditLogService } from '../audit/index.js'
export const policyService = new PolicyService(policyStore, auditLogService)
