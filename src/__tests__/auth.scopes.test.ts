/**
 * @file src/__tests__/auth.scopes.test.ts
 *
 * Comprehensive tests for the granular API scope model.
 * All keys are generated via `generateApiKey()` — no hardcoded keys.
 *
 * Coverage targets
 * ────────────────
 * • ApiScope enum values
 * • SCOPE_SETS expansion (PUBLIC / ENTERPRISE legacy tiers)
 * • scopeSatisfies() helper — all edge cases
 * • requireApiKey() middleware — per-scope enforcement
 *   - missing key → 401
 *   - invalid key → 401
 *   - revoked key → 401
 *   - key with insufficient scope → 403 (deny-by-default)
 *   - key with exact scope → 200 / next()
 *   - key with superset scopes → 200 / next()
 *   - ENTERPRISE key satisfies every granular scope
 *   - PUBLIC key satisfies only read scopes
 *   - req.apiKey metadata shape (scopes array + legacy scope field)
 *   - Authorization: Bearer header accepted alongside X-API-Key
 *   - unknown scope string → deny
 */

import { Request, Response, NextFunction } from 'express'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  requireApiKey,
  ApiScope,
  SCOPE_SETS,
  scopeSatisfies,
  AuthenticatedRequest,
} from '../middleware/auth.js'
import { generateApiKey, _resetStore, revokeApiKey } from '../services/apiKeys.js'
import { userRepo } from '../repositories/userRepository.js'

// ─── helpers ────────────────────────────────────────────────────────────────

function makeReq(headers: Record<string, string> = {}): Partial<Request> {
  return { headers }
}

function makeRes(): { res: Partial<Response>; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn().mockReturnThis()
  const status = vi.fn().mockReturnValue({ json })
  const res = { status, json } as unknown as Partial<Response>
  return { res, status, json }
}

function makeNext(): NextFunction {
  return vi.fn() as unknown as NextFunction
}

/** Helper to create a key with legacy scope string and return the raw key. */
function legacyKey(scope: 'read' | 'full'): string {
  return generateApiKey('u-admin', scope).key
}

/** Helper to create a key with granular scopes and return the raw key. */
function granularKey(scopes: string[]): string {
  return generateApiKey('u-admin', scopes).key
}

// ─── seed on every test ─────────────────────────────────────────────────────

beforeEach(() => {
  _resetStore()
  userRepo._reset()
  userRepo.upsert({ id: 'u-admin', role: 'super-admin', email: 'a@x.com', tenantId: 't-admin' })
  userRepo.upsert({ id: 'u-verifier', role: 'verifier', email: 'v@x.com', tenantId: 't-ver' })
})

// ─── ApiScope enum ───────────────────────────────────────────────────────────

describe('ApiScope enum', () => {
  it('has all granular scope values', () => {
    expect(ApiScope.TRUST_READ).toBe('trust:read')
    expect(ApiScope.ATTESTATIONS_READ).toBe('attestations:read')
    expect(ApiScope.ATTESTATIONS_WRITE).toBe('attestations:write')
    expect(ApiScope.PAYOUTS_WRITE).toBe('payouts:write')
    expect(ApiScope.REPORTS_GENERATE).toBe('reports:generate')
    expect(ApiScope.EXPORTS_READ).toBe('exports:read')
    expect(ApiScope.WEBHOOKS_ADMIN).toBe('webhooks:admin')
    expect(ApiScope.OUTBOX_REINJECT).toBe('outbox:reinject')
    expect(ApiScope.ADMIN_READ).toBe('admin:read')
    expect(ApiScope.ADMIN_WRITE).toBe('admin:write')
    expect(ApiScope.FLAGS_READ).toBe('flags:read')
    expect(ApiScope.FLAGS_WRITE).toBe('flags:write')
    expect(ApiScope.BOND_READ).toBe('bond:read')
    expect(ApiScope.BOND_WRITE).toBe('bond:write')
  })

  it('retains legacy backward-compat values', () => {
    expect(ApiScope.PUBLIC).toBe('public')
    expect(ApiScope.ENTERPRISE).toBe('enterprise')
  })
})

// ─── SCOPE_SETS ──────────────────────────────────────────────────────────────

describe('SCOPE_SETS', () => {
  it('PUBLIC set contains only read scopes', () => {
    const pub = SCOPE_SETS[ApiScope.PUBLIC]
    expect(pub.has(ApiScope.TRUST_READ)).toBe(true)
    expect(pub.has(ApiScope.ATTESTATIONS_READ)).toBe(true)
    // must NOT contain write scopes
    expect(pub.has(ApiScope.ATTESTATIONS_WRITE)).toBe(false)
    expect(pub.has(ApiScope.PAYOUTS_WRITE)).toBe(false)
    expect(pub.has(ApiScope.REPORTS_GENERATE)).toBe(false)
    expect(pub.has(ApiScope.WEBHOOKS_ADMIN)).toBe(false)
    expect(pub.has(ApiScope.ADMIN_READ)).toBe(false)
    expect(pub.has(ApiScope.ADMIN_WRITE)).toBe(false)
    expect(pub.has(ApiScope.BOND_READ)).toBe(false)
    expect(pub.has(ApiScope.BOND_WRITE)).toBe(false)
  })

  it('ENTERPRISE set contains every granular scope', () => {
    const ent = SCOPE_SETS[ApiScope.ENTERPRISE]
    const granular: ApiScope[] = [
      ApiScope.TRUST_READ,
      ApiScope.ATTESTATIONS_READ,
      ApiScope.ATTESTATIONS_WRITE,
      ApiScope.PAYOUTS_WRITE,
      ApiScope.REPORTS_GENERATE,
      ApiScope.EXPORTS_READ,
      ApiScope.WEBHOOKS_ADMIN,
      ApiScope.OUTBOX_REINJECT,
      ApiScope.ADMIN_READ,
      ApiScope.ADMIN_WRITE,
      ApiScope.FLAGS_READ,
      ApiScope.FLAGS_WRITE,
      ApiScope.BOND_READ,
      ApiScope.BOND_WRITE,
    ]
    for (const scope of granular) {
      expect(ent.has(scope)).toBe(true)
    }
  })
})

// ─── scopeSatisfies() ────────────────────────────────────────────────────────

describe('scopeSatisfies()', () => {
  describe('direct match', () => {
    it('returns true when granted set contains the required scope', () => {
      expect(scopeSatisfies([ApiScope.TRUST_READ], ApiScope.TRUST_READ)).toBe(true)
      expect(scopeSatisfies([ApiScope.PAYOUTS_WRITE], ApiScope.PAYOUTS_WRITE)).toBe(true)
    })

    it('returns false when granted set does not contain the required scope', () => {
      expect(scopeSatisfies([ApiScope.TRUST_READ], ApiScope.PAYOUTS_WRITE)).toBe(false)
      expect(scopeSatisfies([ApiScope.ATTESTATIONS_READ], ApiScope.ATTESTATIONS_WRITE)).toBe(false)
    })
  })

  describe('ENTERPRISE superset', () => {
    it('ENTERPRISE scope satisfies every granular scope', () => {
      const granular: ApiScope[] = [
        ApiScope.TRUST_READ,
        ApiScope.ATTESTATIONS_READ,
        ApiScope.ATTESTATIONS_WRITE,
        ApiScope.PAYOUTS_WRITE,
        ApiScope.REPORTS_GENERATE,
        ApiScope.EXPORTS_READ,
        ApiScope.WEBHOOKS_ADMIN,
        ApiScope.OUTBOX_REINJECT,
        ApiScope.ADMIN_READ,
        ApiScope.ADMIN_WRITE,
        ApiScope.FLAGS_READ,
        ApiScope.FLAGS_WRITE,
        ApiScope.BOND_READ,
        ApiScope.BOND_WRITE,
      ]
      for (const scope of granular) {
        expect(scopeSatisfies([ApiScope.ENTERPRISE], scope)).toBe(true)
      }
    })

    it('ENTERPRISE scope satisfies itself', () => {
      expect(scopeSatisfies([ApiScope.ENTERPRISE], ApiScope.ENTERPRISE)).toBe(true)
    })
  })

  describe('PUBLIC legacy expansion', () => {
    it('PUBLIC scope satisfies trust:read', () => {
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.TRUST_READ)).toBe(true)
    })

    it('PUBLIC scope satisfies attestations:read', () => {
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.ATTESTATIONS_READ)).toBe(true)
    })

    it('PUBLIC scope does NOT satisfy write scopes', () => {
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.ATTESTATIONS_WRITE)).toBe(false)
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.PAYOUTS_WRITE)).toBe(false)
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.REPORTS_GENERATE)).toBe(false)
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.WEBHOOKS_ADMIN)).toBe(false)
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.ADMIN_READ)).toBe(false)
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.ADMIN_WRITE)).toBe(false)
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.BOND_READ)).toBe(false)
      expect(scopeSatisfies([ApiScope.PUBLIC], ApiScope.BOND_WRITE)).toBe(false)
    })
  })

  describe('scope subsets', () => {
    it('a key with subset scopes is denied for out-of-scope endpoints', () => {
      const granted = [ApiScope.TRUST_READ, ApiScope.ATTESTATIONS_READ]
      expect(scopeSatisfies(granted, ApiScope.PAYOUTS_WRITE)).toBe(false)
      expect(scopeSatisfies(granted, ApiScope.REPORTS_GENERATE)).toBe(false)
    })

    it('a key with multiple scopes satisfies any of them', () => {
      const granted = [ApiScope.REPORTS_GENERATE, ApiScope.EXPORTS_READ]
      expect(scopeSatisfies(granted, ApiScope.REPORTS_GENERATE)).toBe(true)
      expect(scopeSatisfies(granted, ApiScope.EXPORTS_READ)).toBe(true)
      expect(scopeSatisfies(granted, ApiScope.PAYOUTS_WRITE)).toBe(false)
    })
  })

  describe('empty / unknown scopes', () => {
    it('empty granted set denies everything', () => {
      expect(scopeSatisfies([], ApiScope.TRUST_READ)).toBe(false)
      expect(scopeSatisfies([], ApiScope.ENTERPRISE)).toBe(false)
    })

    it('unknown scope string in granted set does not satisfy a known scope', () => {
      expect(scopeSatisfies(['unknown:scope' as ApiScope], ApiScope.TRUST_READ)).toBe(false)
    })

    it('accepts Set<ApiScope> as well as array', () => {
      const set = new Set([ApiScope.PAYOUTS_WRITE])
      expect(scopeSatisfies(set, ApiScope.PAYOUTS_WRITE)).toBe(true)
      expect(scopeSatisfies(set, ApiScope.TRUST_READ)).toBe(false)
    })
  })
})

// ─── requireApiKey() middleware ──────────────────────────────────────────────

describe('requireApiKey() middleware', () => {
  let next: NextFunction

  beforeEach(() => {
    next = makeNext()
  })

  // ── missing key ────────────────────────────────────────────────────────────

  describe('missing API key', () => {
    it('returns 401 when no key header is present', async () => {
      const req = makeReq()
      const { res, status, json } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthorized' }))
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 401 when X-API-Key is empty string', async () => {
      const req = makeReq({ 'x-api-key': '' })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })
  })

  // ── invalid key ────────────────────────────────────────────────────────────

  describe('invalid API key', () => {
    it('returns 401 for an unrecognised key', async () => {
      const req = makeReq({ 'x-api-key': 'not-a-real-key' })
      const { res, status, json } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthorized', message: 'Invalid API key' }))
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 401 for a random string', async () => {
      const req = makeReq({ 'x-api-key': 'random-garbage-xyz' })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ATTESTATIONS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 401 for revoked keys', async () => {
      const key = generateApiKey('u-admin', 'full')
      revokeApiKey(key.id)

      const req = makeReq({ 'x-api-key': key.key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 401 for unknown but well-formed keys', async () => {
      const randomKey = 'cr_' + 'f'.repeat(64)
      const req = makeReq({ 'x-api-key': randomKey })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })
  })

  // ── insufficient scope (deny-by-default) ──────────────────────────────────

  describe('insufficient scope — deny-by-default', () => {
    it('returns 403 when trust:read key is used on attestations:write endpoint', async () => {
      const key = granularKey(['trust:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status, json } = makeRes()
      await requireApiKey(ApiScope.ATTESTATIONS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Forbidden',
        requiredScope: ApiScope.ATTESTATIONS_WRITE,
      }))
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when attestations:write key is used on payouts:write endpoint', async () => {
      const key = granularKey(['attestations:read', 'attestations:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.PAYOUTS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when reports key is used on webhooks:admin endpoint', async () => {
      const key = granularKey(['reports:generate', 'exports:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.WEBHOOKS_ADMIN)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when admin:read key is used on admin:write endpoint', async () => {
      const key = granularKey(['admin:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ADMIN_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when PUBLIC key is used on payouts:write endpoint', async () => {
      const key = legacyKey('read')
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.PAYOUTS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when PUBLIC key is used on reports:generate endpoint', async () => {
      const key = legacyKey('read')
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.REPORTS_GENERATE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when bond:read key is used on bond:write endpoint', async () => {
      const key = granularKey(['bond:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.BOND_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when bond:read key is used on payouts:write endpoint', async () => {
      const key = granularKey(['bond:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.PAYOUTS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when flags:read key is used on flags:write endpoint', async () => {
      const key = granularKey(['flags:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.FLAGS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('response body includes grantedScopes for debugging', async () => {
      const key = granularKey(['trust:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, json } = makeRes()
      await requireApiKey(ApiScope.PAYOUTS_WRITE)(req as Request, res as Response, next)

      expect(json).toHaveBeenCalledWith(expect.objectContaining({
        grantedScopes: expect.arrayContaining([ApiScope.TRUST_READ]),
      }))
    })
  })

  // ── exact scope match ──────────────────────────────────────────────────────

  describe('exact scope match — allow', () => {
    it('trust:read key passes trust:read endpoint', async () => {
      const key = granularKey(['trust:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('attestations:write key passes attestations:write endpoint', async () => {
      const key = granularKey(['attestations:read', 'attestations:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ATTESTATIONS_WRITE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('attestations:write key also passes attestations:read endpoint (superset)', async () => {
      const key = granularKey(['attestations:read', 'attestations:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ATTESTATIONS_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('payouts:write key passes payouts:write endpoint', async () => {
      const key = granularKey(['payouts:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.PAYOUTS_WRITE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('reports key passes reports:generate endpoint', async () => {
      const key = granularKey(['reports:generate', 'exports:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.REPORTS_GENERATE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('reports key passes exports:read endpoint', async () => {
      const key = granularKey(['reports:generate', 'exports:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.EXPORTS_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('webhooks:admin key passes webhooks:admin endpoint', async () => {
      const key = granularKey(['webhooks:admin'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.WEBHOOKS_ADMIN)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('admin:write key passes admin:read endpoint', async () => {
      const key = granularKey(['admin:read', 'admin:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ADMIN_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('admin:write key passes admin:write endpoint', async () => {
      const key = granularKey(['admin:read', 'admin:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ADMIN_WRITE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('flags:read key passes flags:read endpoint', async () => {
      const key = granularKey(['flags:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.FLAGS_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('flags:write key passes flags:write endpoint', async () => {
      const key = granularKey(['flags:read', 'flags:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.FLAGS_WRITE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('bond:read key passes bond:read endpoint', async () => {
      const key = granularKey(['bond:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.BOND_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('bond:write key passes bond:read endpoint (superset)', async () => {
      const key = granularKey(['bond:read', 'bond:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.BOND_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('bond:write key passes bond:write endpoint', async () => {
      const key = granularKey(['bond:read', 'bond:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.BOND_WRITE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })
  })

  // ── ENTERPRISE superset ────────────────────────────────────────────────────

  describe('ENTERPRISE key — superset of all scopes', () => {
    const allGranularScopes: ApiScope[] = [
      ApiScope.TRUST_READ,
      ApiScope.ATTESTATIONS_READ,
      ApiScope.ATTESTATIONS_WRITE,
      ApiScope.PAYOUTS_WRITE,
      ApiScope.REPORTS_GENERATE,
      ApiScope.EXPORTS_READ,
      ApiScope.WEBHOOKS_ADMIN,
      ApiScope.OUTBOX_REINJECT,
      ApiScope.ADMIN_READ,
      ApiScope.ADMIN_WRITE,
      ApiScope.FLAGS_READ,
      ApiScope.FLAGS_WRITE,
      ApiScope.BOND_READ,
      ApiScope.BOND_WRITE,
    ]

    for (const scope of allGranularScopes) {
      it(`ENTERPRISE key satisfies ${scope}`, async () => {
        const key = legacyKey('full')
        const req = makeReq({ 'x-api-key': key })
        const { res, status } = makeRes()
        await requireApiKey(scope)(req as Request, res as Response, next)

        expect(next).toHaveBeenCalled()
        expect(status).not.toHaveBeenCalled()
      })
    }

    it('ENTERPRISE key satisfies legacy ENTERPRISE scope (backward compat)', async () => {
      const key = legacyKey('full')
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ENTERPRISE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })
  })

  // ── PUBLIC key ─────────────────────────────────────────────────────────────

  describe('PUBLIC key — read-only subset', () => {
    it('PUBLIC key satisfies trust:read', async () => {
      const key = legacyKey('read')
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('PUBLIC key satisfies attestations:read', async () => {
      const key = legacyKey('read')
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ATTESTATIONS_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('PUBLIC key satisfies legacy PUBLIC scope', async () => {
      const key = legacyKey('read')
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.PUBLIC)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    const writeScopes: ApiScope[] = [
      ApiScope.ATTESTATIONS_WRITE,
      ApiScope.PAYOUTS_WRITE,
      ApiScope.REPORTS_GENERATE,
      ApiScope.EXPORTS_READ,
      ApiScope.WEBHOOKS_ADMIN,
      ApiScope.ADMIN_READ,
      ApiScope.ADMIN_WRITE,
      ApiScope.BOND_READ,
      ApiScope.BOND_WRITE,
    ]

    for (const scope of writeScopes) {
      it(`PUBLIC key is denied for ${scope}`, async () => {
        const key = legacyKey('read')
        const req = makeReq({ 'x-api-key': key })
        const { res, status } = makeRes()
        await requireApiKey(scope)(req as Request, res as Response, next)

        expect(status).toHaveBeenCalledWith(403)
        expect(next).not.toHaveBeenCalled()
      })
    }
  })

  // ── req.apiKey metadata ────────────────────────────────────────────────────

  describe('req.apiKey metadata', () => {
    it('attaches scopes array to req.apiKey', async () => {
      const key = granularKey(['attestations:read', 'attestations:write'])
      const req = makeReq({ 'x-api-key': key })
      const { res } = makeRes()
      await requireApiKey(ApiScope.ATTESTATIONS_WRITE)(req as Request, res as Response, next)

      const authReq = req as AuthenticatedRequest & { apiKey: any }
      expect(authReq.apiKey).toBeDefined()
      expect(authReq.apiKey.scopes).toContain('attestations:read')
      expect(authReq.apiKey.scopes).toContain('attestations:write')
    })

    it('attaches legacy scope field for backward compatibility', async () => {
      const key = legacyKey('full')
      const req = makeReq({ 'x-api-key': key })
      const { res } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      const authReq = req as any
      expect(authReq.apiKey.scope).toBe('full')
    })

    it('attaches StoredApiKey record with ownerId to req.apiKey', async () => {
      const key = granularKey(['trust:read'])
      const req = makeReq({ 'x-api-key': key })
      const { res } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      const authReq = req as any
      expect(authReq.apiKey).toBeDefined()
      expect(authReq.apiKey.ownerId).toBe('u-admin')
      expect(authReq.apiKey.active).toBe(true)
    })
  })

  // ── Authorization: Bearer header ──────────────────────────────────────────

  describe('Authorization: Bearer header', () => {
    it('accepts key from Authorization: Bearer header', async () => {
      const key = granularKey(['trust:read'])
      const req = makeReq({ authorization: `Bearer ${key}` })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('X-API-Key takes precedence over Authorization header', async () => {
      const goodKey = granularKey(['trust:read'])
      const badKeyStr = 'cr_' + 'b'.repeat(64)
      const req = makeReq({
        'x-api-key': goodKey,
        authorization: `Bearer ${badKeyStr}`,
      })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('returns 401 when Bearer token is invalid', async () => {
      const req = makeReq({ authorization: 'Bearer not-a-real-key' })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })
  })

  // ── backward compatibility ─────────────────────────────────────────────────

  describe('backward compatibility', () => {
    it('full-scope key satisfies ENTERPRISE scope (backward compat)', async () => {
      const key = legacyKey('full')
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ENTERPRISE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('read-scope key satisfies PUBLIC scope (backward compat)', async () => {
      const key = legacyKey('read')
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.PUBLIC)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('PUBLIC key is denied for ENTERPRISE scope', async () => {
      const key = legacyKey('read')
      const req = makeReq({ 'x-api-key': key })
      const { res, status } = makeRes()
      await requireApiKey(ApiScope.ENTERPRISE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })
  })
})
