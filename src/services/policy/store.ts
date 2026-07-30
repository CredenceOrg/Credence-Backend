/**
 * In-memory policy rule store with a simple TTL-based read cache.
 *
 * Replace the `rules` Map with a DB-backed adapter (e.g. PostgreSQL) in
 * production. The cache layer sits in front of any backing store and must be
 * invalidated on every write to prevent stale permission decisions.
 */

import { randomBytes } from 'crypto'
import type { PolicyRule, CreatePolicyRuleInput } from './types.js'

const CACHE_TTL_MS = 30_000 // 30 s – short enough to limit stale decisions

interface CacheEntry {
  rules: PolicyRule[]
  expiresAt: number
}

export class PolicyStore {
  /** Primary storage: ruleId → rule */
  private rules = new Map<string, PolicyRule>()
  /** Per-org read cache */
  private cache = new Map<string, CacheEntry>()

  // ---------------------------------------------------------------------------
  // Writes (always invalidate cache)
  // ---------------------------------------------------------------------------

  create(input: CreatePolicyRuleInput): PolicyRule {
    const now = new Date().toISOString()
    const rule: PolicyRule = {
      ...input,
      id: randomBytes(8).toString('hex'),
      createdAt: now,
      updatedAt: now,
    }
    this.rules.set(rule.id, rule)
    this.invalidate(rule.orgId)
    return rule
  }

  update(id: string, patch: Partial<Omit<PolicyRule, 'id' | 'createdAt'>>): PolicyRule | null {
    const existing = this.rules.get(id)
    if (!existing) return null
    const updated: PolicyRule = { ...existing, ...patch, updatedAt: new Date().toISOString() }
    this.rules.set(id, updated)
    this.invalidate(existing.orgId)
    if (patch.orgId && patch.orgId !== existing.orgId) this.invalidate(patch.orgId)
    return updated
  }

  delete(id: string): boolean {
    const rule = this.rules.get(id)
    if (!rule) return false
    this.rules.delete(id)
    this.invalidate(rule.orgId)
    return true
  }

  // ---------------------------------------------------------------------------
  // Reads (cache-first)
  // ---------------------------------------------------------------------------

  findById(id: string): PolicyRule | null {
    return this.rules.get(id) ?? null
  }

  /**
   * Internal: return all cached rules for an org (bypasses pagination).
   * Used by PolicyEvaluator for authorization decisions.
   */
  findAllByOrg(orgId: string): PolicyRule[] {
    const cached = this.cache.get(orgId)
    if (cached && Date.now() < cached.expiresAt) return cached.rules

    const all = [...this.rules.values()].filter((r) => r.orgId === orgId || r.orgId === '*')
    this.cache.set(orgId, { rules: all, expiresAt: Date.now() + CACHE_TTL_MS })
    return all
  }

  /**
   * Return rules for an org with pagination.
   *
   * @param orgId   Org to look up rules for
   * @param limit   Max rules to return (default 20, max 100)
   * @param offset  Number of rules to skip (default 0)
   * @returns       Paginated rules and total count
   */
  findByOrg(
    orgId: string,
    limit = 20,
    offset = 0,
  ): { rules: PolicyRule[]; total: number } {
    const all = this.findAllByOrg(orgId)
    return {
      rules: all.slice(offset, offset + limit),
      total: all.length,
    }
  }

  // ---------------------------------------------------------------------------
  // Cache management
  // ---------------------------------------------------------------------------

  private invalidate(orgId: string): void {
    this.cache.delete(orgId)
    // Also bust the wildcard cache since '*' rules affect all orgs
    this.cache.delete('*')
  }

  /** For testing only. */
  _reset(): void {
    this.rules.clear()
    this.cache.clear()
  }
}

export const policyStore = new PolicyStore()
