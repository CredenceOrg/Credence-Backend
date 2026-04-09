/**
 * Tests for PolicyEvaluator:
 *  - deny-by-default
 *  - explicit allow
 *  - explicit deny wins over allow
 *  - role inheritance (hierarchical subject matching)
 *  - user-specific subject override
 *  - condition matching
 *  - admin fallback when no rules exist
 */

import { describe, it, expect } from 'vitest'
import { PolicyEvaluator } from '../evaluator.js'
import { PolicyStore } from '../store.js'
import type { PolicyContext } from '../types.js'

function makeStore(...rules: Parameters<PolicyStore['create']>[0][]): PolicyStore {
  const store = new PolicyStore()
  for (const r of rules) store.create(r)
  return store
}

const baseCtx: PolicyContext = {
  userId: 'user-1',
  role: 'user',
  orgId: 'org-acme',
  action: 'org:member:list',
  resource: 'org:org-acme:members',
}

describe('PolicyEvaluator', () => {
  describe('deny-by-default', () => {
    it('denies when no rules exist and caller is not admin', () => {
      const ev = new PolicyEvaluator(new PolicyStore())
      const result = ev.evaluate(baseCtx)
      expect(result.allowed).toBe(false)
      expect(result.reason).toMatch(/deny by default/i)
    })
  })

  describe('explicit allow', () => {
    it('allows when a matching allow rule exists', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'user',
        action: 'org:member:list',
        resource: 'org:org-acme:members',
        effect: 'allow',
      })
      const ev = new PolicyEvaluator(store)
      expect(ev.evaluate(baseCtx).allowed).toBe(true)
    })

    it('allows via wildcard action', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'user',
        action: '*',
        resource: '*',
        effect: 'allow',
      })
      const ev = new PolicyEvaluator(store)
      expect(ev.evaluate(baseCtx).allowed).toBe(true)
    })

    it('allows via resource prefix wildcard', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'user',
        action: 'org:member:list',
        resource: 'org:org-acme:*',
        effect: 'allow',
      })
      const ev = new PolicyEvaluator(store)
      expect(ev.evaluate(baseCtx).allowed).toBe(true)
    })
  })

  describe('deny precedence', () => {
    it('deny wins over allow when both match', () => {
      const store = makeStore(
        {
          orgId: 'org-acme',
          subject: 'user',
          action: 'org:member:list',
          resource: '*',
          effect: 'allow',
        },
        {
          orgId: 'org-acme',
          subject: 'user',
          action: 'org:member:list',
          resource: 'org:org-acme:members',
          effect: 'deny',
        },
      )
      const ev = new PolicyEvaluator(store)
      const result = ev.evaluate(baseCtx)
      expect(result.allowed).toBe(false)
      expect(result.reason).toMatch(/explicit deny/i)
    })
  })

  describe('role inheritance', () => {
    it('verifier inherits rules granted to user', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'user', // granted to user level
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
      })
      const ev = new PolicyEvaluator(store)
      const result = ev.evaluate({ ...baseCtx, role: 'verifier' })
      expect(result.allowed).toBe(true)
    })

    it('admin inherits rules granted to verifier', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'verifier',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
      })
      const ev = new PolicyEvaluator(store)
      expect(ev.evaluate({ ...baseCtx, role: 'admin' }).allowed).toBe(true)
    })

    it('user does NOT inherit rules granted only to verifier', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'verifier',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
      })
      const ev = new PolicyEvaluator(store)
      expect(ev.evaluate({ ...baseCtx, role: 'user' }).allowed).toBe(false)
    })
  })

  describe('user-specific subject', () => {
    it('allows a specific user regardless of role', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'user:user-1',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
      })
      const ev = new PolicyEvaluator(store)
      expect(ev.evaluate({ ...baseCtx, role: 'public' }).allowed).toBe(true)
    })

    it('does not match a different user', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'user:user-99',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
      })
      const ev = new PolicyEvaluator(store)
      expect(ev.evaluate(baseCtx).allowed).toBe(false)
    })
  })

  describe('condition matching', () => {
    it('allows when all conditions match', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'user',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
        conditions: { region: 'us-east-1' },
      })
      const ev = new PolicyEvaluator(store)
      expect(
        ev.evaluate({ ...baseCtx, extra: { region: 'us-east-1' } }).allowed,
      ).toBe(true)
    })

    it('denies when a condition does not match', () => {
      const store = makeStore({
        orgId: 'org-acme',
        subject: 'user',
        action: 'org:member:list',
        resource: '*',
        effect: 'allow',
        conditions: { region: 'us-east-1' },
      })
      const ev = new PolicyEvaluator(store)
      expect(
        ev.evaluate({ ...baseCtx, extra: { region: 'eu-west-1' } }).allowed,
      ).toBe(false)
    })
  })

  describe('admin fallback', () => {
    it('allows admin even when no rules exist', () => {
      const ev = new PolicyEvaluator(new PolicyStore())
      expect(ev.evaluate({ ...baseCtx, role: 'admin' }).allowed).toBe(true)
    })

    it('does not apply admin fallback to verifier', () => {
      const ev = new PolicyEvaluator(new PolicyStore())
      expect(ev.evaluate({ ...baseCtx, role: 'verifier' }).allowed).toBe(false)
    })
  })

  describe('platform-wide rules (orgId=*)', () => {
    it('platform-wide allow rule applies to any org', () => {
      const store = makeStore({
        orgId: '*',
        subject: 'verifier',
        action: 'org:read',
        resource: '*',
        effect: 'allow',
      })
      const ev = new PolicyEvaluator(store)
      expect(
        ev.evaluate({ ...baseCtx, role: 'verifier', action: 'org:read', resource: 'org:org-acme' }).allowed,
      ).toBe(true)
    })
  })
})
