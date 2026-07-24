/**
 * @file src/__tests__/auth.scopes.test.ts
 *
 * Comprehensive tests for the granular API scope model.
 *
 * Coverage targets
 * ────────────────
 * • ApiScope enum values
 * • SCOPE_SETS expansion (PUBLIC / ENTERPRISE legacy tiers)
 * • scopeSatisfies() helper — all edge cases
 * • requireApiKey() middleware — per-scope enforcement
 *   - missing key → 401
 *   - invalid key → 401
 *   - key with insufficient scope → 403 (deny-by-default)
 *   - key with exact scope → 200 / next()
 *   - key with superset scopes → 200 / next()
 *   - ENTERPRISE key satisfies every granular scope
 *   - PUBLIC key satisfies only read scopes
 *   - req.apiKey metadata shape (scopes array + legacy scope field)
 *   - Authorization: Bearer header accepted alongside X-API-Key
 *   - unknown scope string → deny
 *   - backward compat: existing test-enterprise-key-12345 still works
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
    expect(ApiScope.ADMIN_READ).toBe('admin:read')
    expect(ApiScope.ADMIN_WRITE).toBe('admin:write')
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
      ApiScope.ADMIN_READ,
      ApiScope.ADMIN_WRITE,
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
        ApiScope.ADMIN_READ,
        ApiScope.ADMIN_WRITE,
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
    it('returns 401 when no key header is present', () => {
      const req = makeReq()
      const { res, status, json } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthorized' }))
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 401 when X-API-Key is empty string', () => {
      const req = makeReq({ 'x-api-key': '' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })
  })

  // ── invalid key ────────────────────────────────────────────────────────────

  describe('invalid API key', () => {
    it('returns 401 for an unrecognised key', () => {
      const req = makeReq({ 'x-api-key': 'not-a-real-key' })
      const { res, status, json } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthorized', message: 'Invalid API key' }))
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 401 for a random string', () => {
      const req = makeReq({ 'x-api-key': 'random-garbage-xyz' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ATTESTATIONS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })
  })

  // ── insufficient scope (deny-by-default) ──────────────────────────────────

  describe('insufficient scope — deny-by-default', () => {
    it('returns 403 when trust:read key is used on attestations:write endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-trust-read-key' })
      const { res, status, json } = makeRes()
      requireApiKey(ApiScope.ATTESTATIONS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Forbidden',
        requiredScope: ApiScope.ATTESTATIONS_WRITE,
      }))
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when attestations:write key is used on payouts:write endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-attestations-write-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.PAYOUTS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when reports key is used on webhooks:admin endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-reports-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.WEBHOOKS_ADMIN)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when admin:read key is used on admin:write endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-admin-read-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ADMIN_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when PUBLIC key is used on payouts:write endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-public-key-67890' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.PAYOUTS_WRITE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 when PUBLIC key is used on reports:generate endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-public-key-67890' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.REPORTS_GENERATE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('response body includes grantedScopes for debugging', () => {
      const req = makeReq({ 'x-api-key': 'test-trust-read-key' })
      const { res, json } = makeRes()
      requireApiKey(ApiScope.PAYOUTS_WRITE)(req as Request, res as Response, next)

      expect(json).toHaveBeenCalledWith(expect.objectContaining({
        grantedScopes: expect.arrayContaining([ApiScope.TRUST_READ]),
      }))
    })
  })

  // ── exact scope match ──────────────────────────────────────────────────────

  describe('exact scope match — allow', () => {
    it('trust:read key passes trust:read endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-trust-read-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('attestations:write key passes attestations:write endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-attestations-write-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ATTESTATIONS_WRITE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('attestations:write key also passes attestations:read endpoint (superset)', () => {
      const req = makeReq({ 'x-api-key': 'test-attestations-write-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ATTESTATIONS_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('payouts:write key passes payouts:write endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-payouts-write-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.PAYOUTS_WRITE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('reports key passes reports:generate endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-reports-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.REPORTS_GENERATE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('reports key passes exports:read endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-reports-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.EXPORTS_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('webhooks:admin key passes webhooks:admin endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-webhooks-admin-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.WEBHOOKS_ADMIN)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('admin:write key passes admin:read endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-admin-write-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ADMIN_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('admin:write key passes admin:write endpoint', () => {
      const req = makeReq({ 'x-api-key': 'test-admin-write-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ADMIN_WRITE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })
  })

  // ── ENTERPRISE superset ────────────────────────────────────────────────────

  describe('ENTERPRISE key — superset of all scopes', () => {
    const enterpriseKey = 'test-enterprise-key-12345'

    const allGranularScopes: ApiScope[] = [
      ApiScope.TRUST_READ,
      ApiScope.ATTESTATIONS_READ,
      ApiScope.ATTESTATIONS_WRITE,
      ApiScope.PAYOUTS_WRITE,
      ApiScope.REPORTS_GENERATE,
      ApiScope.EXPORTS_READ,
      ApiScope.WEBHOOKS_ADMIN,
      ApiScope.ADMIN_READ,
      ApiScope.ADMIN_WRITE,
    ]

    for (const scope of allGranularScopes) {
      it(`ENTERPRISE key satisfies ${scope}`, () => {
        const req = makeReq({ 'x-api-key': enterpriseKey })
        const { res, status } = makeRes()
        requireApiKey(scope)(req as Request, res as Response, next)

        expect(next).toHaveBeenCalled()
        expect(status).not.toHaveBeenCalled()
      })
    }

    it('ENTERPRISE key satisfies legacy ENTERPRISE scope (backward compat)', () => {
      const req = makeReq({ 'x-api-key': enterpriseKey })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ENTERPRISE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })
  })

  // ── PUBLIC key ─────────────────────────────────────────────────────────────

  describe('PUBLIC key — read-only subset', () => {
    const publicKey = 'test-public-key-67890'

    it('PUBLIC key satisfies trust:read', () => {
      const req = makeReq({ 'x-api-key': publicKey })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('PUBLIC key satisfies attestations:read', () => {
      const req = makeReq({ 'x-api-key': publicKey })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ATTESTATIONS_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('PUBLIC key satisfies legacy PUBLIC scope', () => {
      const req = makeReq({ 'x-api-key': publicKey })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.PUBLIC)(req as Request, res as Response, next)

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
    ]

    for (const scope of writeScopes) {
      it(`PUBLIC key is denied for ${scope}`, () => {
        const req = makeReq({ 'x-api-key': publicKey })
        const { res, status } = makeRes()
        requireApiKey(scope)(req as Request, res as Response, next)

        expect(status).toHaveBeenCalledWith(403)
        expect(next).not.toHaveBeenCalled()
      })
    }
  })

  // ── req.apiKey metadata ────────────────────────────────────────────────────

  describe('req.apiKey metadata', () => {
    it('attaches scopes array to req.apiKey', () => {
      const req = makeReq({ 'x-api-key': 'test-attestations-write-key' })
      const { res } = makeRes()
      requireApiKey(ApiScope.ATTESTATIONS_WRITE)(req as Request, res as Response, next)

      const authReq = req as AuthenticatedRequest & { apiKey: any }
      expect(authReq.apiKey).toBeDefined()
      expect(authReq.apiKey.scopes).toContain(ApiScope.ATTESTATIONS_READ)
      expect(authReq.apiKey.scopes).toContain(ApiScope.ATTESTATIONS_WRITE)
    })

    it('attaches legacy scope field for backward compatibility', () => {
      const req = makeReq({ 'x-api-key': 'test-enterprise-key-12345' })
      const { res } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      const authReq = req as any
      expect(authReq.apiKey.scope).toBe(ApiScope.ENTERPRISE)
    })

    it('attaches key value to req.apiKey.key', () => {
      const req = makeReq({ 'x-api-key': 'test-trust-read-key' })
      const { res } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      const authReq = req as any
      expect(authReq.apiKey.key).toBe('test-trust-read-key')
    })
  })

  // ── Authorization: Bearer header ──────────────────────────────────────────

  describe('Authorization: Bearer header', () => {
    it('accepts key from Authorization: Bearer header', () => {
      const req = makeReq({ authorization: 'Bearer test-trust-read-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('X-API-Key takes precedence over Authorization header', () => {
      // X-API-Key has a valid key; Authorization has an invalid one
      const req = makeReq({
        'x-api-key': 'test-trust-read-key',
        authorization: 'Bearer invalid-key',
      })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('returns 401 when Bearer token is invalid', () => {
      const req = makeReq({ authorization: 'Bearer not-a-real-key' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.TRUST_READ)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })
  })

  // ── backward compatibility ─────────────────────────────────────────────────

  describe('backward compatibility', () => {
    it('existing test-enterprise-key-12345 still works for ENTERPRISE scope', () => {
      const req = makeReq({ 'x-api-key': 'test-enterprise-key-12345' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ENTERPRISE)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('existing test-public-key-67890 still works for PUBLIC scope', () => {
      const req = makeReq({ 'x-api-key': 'test-public-key-67890' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.PUBLIC)(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('existing enterprise key is denied for ENTERPRISE scope when using public key', () => {
      const req = makeReq({ 'x-api-key': 'test-public-key-67890' })
      const { res, status } = makeRes()
      requireApiKey(ApiScope.ENTERPRISE)(req as Request, res as Response, next)

      expect(status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })
  })
})
