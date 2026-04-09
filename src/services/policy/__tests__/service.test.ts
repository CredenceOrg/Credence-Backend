/**
 * Tests for PolicyService:
 *  - createRule emits audit entry
 *  - updateRule emits audit entry
 *  - deleteRule emits audit entry
 *  - updateRule / deleteRule throw on unknown id
 */

import { describe, it, expect } from 'vitest'
import { PolicyService } from '../service.js'
import { PolicyStore } from '../store.js'
import { AuditLogService, AuditAction } from '../../audit/index.js'

function makeService() {
  const store = new PolicyStore()
  const audit = new AuditLogService()
  const svc = new PolicyService(store, audit)
  return { svc, store, audit }
}

const actor = { id: 'admin-1', email: 'admin@credence.org' }

describe('PolicyService', () => {
  describe('createRule', () => {
    it('persists the rule and emits POLICY_RULE_CREATED audit entry', () => {
      const { svc, audit } = makeService()
      const rule = svc.createRule(actor.id, actor.email, {
        orgId: 'org-acme',
        subject: 'user',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
      })
      expect(rule.id).toBeDefined()
      const { logs } = audit.getLogs({ action: AuditAction.POLICY_RULE_CREATED })
      expect(logs).toHaveLength(1)
      expect(logs[0].details).toMatchObject({ ruleId: rule.id, orgId: 'org-acme' })
    })
  })

  describe('updateRule', () => {
    it('updates the rule and emits POLICY_RULE_UPDATED audit entry', () => {
      const { svc, audit } = makeService()
      const rule = svc.createRule(actor.id, actor.email, {
        orgId: 'org-acme',
        subject: 'user',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
      })
      const updated = svc.updateRule(actor.id, actor.email, rule.id, { effect: 'deny' })
      expect(updated.effect).toBe('deny')
      const { logs } = audit.getLogs({ action: AuditAction.POLICY_RULE_UPDATED })
      expect(logs).toHaveLength(1)
    })

    it('throws when rule id does not exist', () => {
      const { svc } = makeService()
      expect(() => svc.updateRule(actor.id, actor.email, 'ghost', {})).toThrow('not found')
    })
  })

  describe('deleteRule', () => {
    it('removes the rule and emits POLICY_RULE_DELETED audit entry', () => {
      const { svc, audit } = makeService()
      const rule = svc.createRule(actor.id, actor.email, {
        orgId: 'org-acme',
        subject: 'user',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
      })
      svc.deleteRule(actor.id, actor.email, rule.id)
      expect(svc.getRule(rule.id)).toBeNull()
      const { logs } = audit.getLogs({ action: AuditAction.POLICY_RULE_DELETED })
      expect(logs).toHaveLength(1)
    })

    it('throws when rule id does not exist', () => {
      const { svc } = makeService()
      expect(() => svc.deleteRule(actor.id, actor.email, 'ghost')).toThrow('not found')
    })
  })

  describe('authorize', () => {
    it('returns allowed=true for a matching allow rule', () => {
      const { svc } = makeService()
      svc.createRule(actor.id, actor.email, {
        orgId: 'org-acme',
        subject: 'user',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
      })
      const decision = svc.authorize({
        userId: 'u1',
        role: 'user',
        orgId: 'org-acme',
        action: 'org:member:list',
        resource: 'org:org-acme:members',
      })
      expect(decision.allowed).toBe(true)
    })
  })
})
