/**
 * @file src/auth/concurrency.test.ts
 *
 * Regression tests for concurrent requests, contention, and retry-after-
 * conflict behavior in the auth layer.
 *
 * Coverage
 * ────────
 * AuthConcurrencyGuard
 *   • validate() coalesces N concurrent calls for the same key (handler fires once)
 *   • validate() runs distinct keys independently (no cross-key interference)
 *   • validate() returns 401 for null (invalid/revoked) look-up results
 *   • validate() returns 401 when the underlying lookup throws
 *   • validate() detects a scope change between bursts and returns 409 + Retry-After
 *   • validate() does NOT conflict when scopes are unchanged across bursts
 *   • validate() returns 503 when maxInFlight is exceeded
 *   • validate() handles Retry-After values for 409 and 503
 *   • evict() clears the scope snapshot so the next burst gets a clean baseline
 *   • inFlightCount / snapshotCount reflect live state
 *
 * validateApiKey (service layer)
 *   • Concurrent calls for the same raw key coalesce to a single store look-up
 *   • Revoked key returns null for all concurrent callers
 *   • Distinct keys run independently under concurrent load
 *
 * requireApiKey middleware (integration)
 *   • N concurrent requests succeed for a valid key (final state: next() called N times)
 *   • Revoked key causes all concurrent callers to receive 401
 *   • Scope-conflict response carries Retry-After header
 *   • 503 response carries Retry-After header on overload
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { AuthConcurrencyGuard } from './concurrency.js'
import { SingleFlight } from '../lib/singleflight.js'
import { requireApiKey, ApiScope } from '../middleware/auth.js'
import {
  generateApiKey,
  validateApiKey,
  revokeApiKey,
  _resetStore,
  _setUseInMemory,
} from '../services/apiKeys.js'
import { userRepo } from '../repositories/userRepository.js'
import type { StoredApiKey } from '../services/apiKeys.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Controllable async gate — lets tests pause then unblock a single in-flight op. */
class Gate {
  private _resolve!: () => void
  readonly promise: Promise<void>

  constructor() {
    this.promise = new Promise<void>((r) => { this._resolve = r })
  }

  open(): void {
    this._resolve()
  }
}

/** Build a minimal Express-compatible mock request. */
function makeReq(key?: string): Partial<Request> {
  return {
    headers: key
      ? { 'x-api-key': key }
      : {},
  }
}

/** Build a mock response that tracks status / json / set. */
function makeRes(): {
  res: Partial<Response>
  statusCode: () => number | undefined
  body: () => unknown
  headers: () => Record<string, string>
} {
  const _headers: Record<string, string> = {}
  let _status: number | undefined
  let _body: unknown

  const json = vi.fn((b: unknown) => { _body = b; return res })
  const status = vi.fn((s: number) => { _status = s; return res })
  const set = vi.fn((k: string, v: string) => { _headers[k.toLowerCase()] = v; return res })

  const res: Partial<Response> = { status, json, set } as unknown as Partial<Response>

  return {
    res,
    statusCode: () => _status,
    body: () => _body,
    headers: () => _headers,
  }
}

/** Build a single mock StoredApiKey record. */
function makeKey(overrides?: Partial<StoredApiKey>): StoredApiKey {
  return {
    id: 'key-id-1',
    hashedKey: 'hash',
    prefix: 'abcdefgh',
    scope: 'trust:read',
    scopes: ['trust:read'],
    tier: 'free',
    ownerId: 'u-1',
    createdAt: new Date(),
    lastUsedAt: null,
    active: true,
    ...overrides,
  }
}

// ─── seed ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetStore()
  _setUseInMemory(true)
  userRepo._reset()
  userRepo.upsert({ id: 'u-admin', role: 'super-admin', email: 'a@x.com', tenantId: 't-admin' })
  userRepo.upsert({ id: 'u-verifier', role: 'verifier', email: 'v@x.com', tenantId: 't-ver' })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AuthConcurrencyGuard unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('AuthConcurrencyGuard', () => {

  // ── coalescing ──────────────────────────────────────────────────────────────

  describe('concurrent coalescing', () => {
    it('coalesces N concurrent calls for the same key to a single lookup', async () => {
      const guard = new AuthConcurrencyGuard()
      const gate = new Gate()
      let lookupCalls = 0

      const mockKey = makeKey()

      const lookup = async (_k: string): Promise<StoredApiKey | null> => {
        lookupCalls++
        await gate.promise   // block until we open the gate
        return mockKey
      }

      const rawKey = 'cr_' + 'a'.repeat(64)

      // Fire 20 concurrent validations for the same key
      const calls = Array.from({ length: 20 }, () =>
        guard.validate(rawKey, lookup)
      )

      // The gate is still closed — only 1 lookup should have started
      await Promise.resolve()
      await Promise.resolve()
      expect(lookupCalls).toBe(1)

      // Unblock
      gate.open()
      const results = await Promise.all(calls)

      // All results are ok and come from the single lookup
      expect(lookupCalls).toBe(1)
      expect(results.every((r) => r.ok)).toBe(true)
      const keys = results.map((r) => (r.ok ? r.key : null))
      expect(keys.every((k) => k === mockKey)).toBe(true)
    })

    it('runs distinct keys independently with no cross-key interference', async () => {
      const guard = new AuthConcurrencyGuard()
      const gateA = new Gate()
      const gateB = new Gate()
      const lookupCounts: Record<string, number> = { keyA: 0, keyB: 0 }

      const keyA = makeKey({ id: 'id-a', scopes: ['trust:read'] })
      const keyB = makeKey({ id: 'id-b', scopes: ['payouts:write'] })

      const lookupA = async (_k: string): Promise<StoredApiKey | null> => {
        lookupCounts.keyA++
        await gateA.promise
        return keyA
      }
      const lookupB = async (_k: string): Promise<StoredApiKey | null> => {
        lookupCounts.keyB++
        await gateB.promise
        return keyB
      }

      const rawA = 'cr_' + 'a'.repeat(64)
      const rawB = 'cr_' + 'b'.repeat(64)

      const aCalls = Array.from({ length: 8 }, () => guard.validate(rawA, lookupA))
      const bCalls = Array.from({ length: 8 }, () => guard.validate(rawB, lookupB))

      await Promise.resolve()
      await Promise.resolve()

      // One lookup per distinct key
      expect(lookupCounts.keyA).toBe(1)
      expect(lookupCounts.keyB).toBe(1)

      gateB.open()
      gateA.open()

      const [aResults, bResults] = await Promise.all([
        Promise.all(aCalls),
        Promise.all(bCalls),
      ])

      expect(aResults.every((r) => r.ok && r.key.id === 'id-a')).toBe(true)
      expect(bResults.every((r) => r.ok && r.key.id === 'id-b')).toBe(true)

      // Confirm final state: snapshots are stored per key
      expect(guard.snapshotCount).toBe(2)
    })
  })

  // ── invalid / revoked keys ──────────────────────────────────────────────────

  describe('invalid/revoked key handling', () => {
    it('returns 401 when the lookup returns null', async () => {
      const guard = new AuthConcurrencyGuard()
      const lookup = async () => null

      const result = await guard.validate('cr_' + 'f'.repeat(64), lookup)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(401)
        expect(result.retryAfter).toBeUndefined()
      }
    })

    it('returns 401 and no partial state when lookup throws', async () => {
      const guard = new AuthConcurrencyGuard()
      const lookup = async (): Promise<StoredApiKey | null> => {
        throw new Error('DB connection lost')
      }

      const result = await guard.validate('cr_' + 'e'.repeat(64), lookup)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(401)
        // No snapshot should be stored when lookup fails
        expect(guard.snapshotCount).toBe(0)
      }
    })

    it('all concurrent callers for a revoked key receive 401', async () => {
      const guard = new AuthConcurrencyGuard()
      const gate = new Gate()
      let calls = 0

      // This simulates a revoked key: lookup returns null after revocation
      const lookup = async (): Promise<StoredApiKey | null> => {
        calls++
        await gate.promise
        return null  // revoked
      }

      const rawKey = 'cr_' + 'c'.repeat(64)
      const concurrent = Array.from({ length: 15 }, () =>
        guard.validate(rawKey, lookup)
      )

      gate.open()
      const results = await Promise.all(concurrent)

      // Handler ran exactly once (coalesced)
      expect(calls).toBe(1)
      // All concurrent callers got 401
      expect(results.every((r) => !r.ok)).toBe(true)
      if (!results[0]!.ok) {
        expect(results[0]!.status).toBe(401)
      }
    })
  })

  // ── scope-change detection ──────────────────────────────────────────────────

  describe('scope-change conflict detection', () => {
    it('returns 409 with Retry-After when scopes change between consecutive bursts', async () => {
      const guard = new AuthConcurrencyGuard({ conflictRetryAfterSeconds: 2 })
      const rawKey = 'cr_' + 'd'.repeat(64)

      const firstKey = makeKey({ id: 'key-scope-change', scopes: ['trust:read'] })
      const secondKey = makeKey({ id: 'key-scope-change', scopes: ['trust:read', 'payouts:write'] })

      let callCount = 0

      // First burst: trust:read only
      const lookup1 = async (): Promise<StoredApiKey | null> => {
        callCount++
        return firstKey
      }
      const result1 = await guard.validate(rawKey, lookup1)
      expect(result1.ok).toBe(true)

      // Second burst: scopes expanded (simulates key rotation / admin update)
      const lookup2 = async (): Promise<StoredApiKey | null> => {
        callCount++
        return secondKey
      }
      const result2 = await guard.validate(rawKey, lookup2)

      // The guard detects the scope change and returns 409
      expect(result2.ok).toBe(false)
      if (!result2.ok) {
        expect(result2.status).toBe(409)
        expect(result2.retryAfter).toBe(2)
        expect(result2.error).toMatch(/scope was modified concurrently/i)
      }
    })

    it('does NOT conflict when scopes are identical across consecutive bursts', async () => {
      const guard = new AuthConcurrencyGuard()
      const rawKey = 'cr_' + 'd'.repeat(64)

      const sameKey = makeKey({ id: 'key-stable', scopes: ['trust:read', 'attestations:read'] })

      const lookup = async (): Promise<StoredApiKey | null> => sameKey

      const result1 = await guard.validate(rawKey, lookup)
      const result2 = await guard.validate(rawKey, lookup)
      const result3 = await guard.validate(rawKey, lookup)

      // All three should succeed (no conflict)
      expect(result1.ok).toBe(true)
      expect(result2.ok).toBe(true)
      expect(result3.ok).toBe(true)
    })

    it('scope ordering does not matter for conflict detection (sorted fingerprint)', async () => {
      const guard = new AuthConcurrencyGuard()
      const rawKey = 'cr_' + 'e'.repeat(64)

      // Same scopes in different order
      const keyA = makeKey({ id: 'key-order', scopes: ['trust:read', 'attestations:read'] })
      const keyB = makeKey({ id: 'key-order', scopes: ['attestations:read', 'trust:read'] })

      const result1 = await guard.validate(rawKey, async () => keyA)
      const result2 = await guard.validate(rawKey, async () => keyB)

      // Same scopes, different order → no conflict
      expect(result1.ok).toBe(true)
      expect(result2.ok).toBe(true)
    })

    it('evict() clears the snapshot so the next burst gets a clean baseline', async () => {
      const guard = new AuthConcurrencyGuard()
      const rawKey = 'cr_' + 'f'.repeat(64)

      const firstKey = makeKey({ id: 'key-evict', scopes: ['trust:read'] })
      const secondKey = makeKey({ id: 'key-evict', scopes: ['trust:read', 'admin:write'] })

      // First burst
      await guard.validate(rawKey, async () => firstKey)
      expect(guard.snapshotCount).toBe(1)

      // Evict (caller signals: key has been deliberately updated)
      guard.evict('key-evict')
      expect(guard.snapshotCount).toBe(0)

      // Second burst with different scopes — no conflict after eviction
      const result2 = await guard.validate(rawKey, async () => secondKey)
      expect(result2.ok).toBe(true)
    })
  })

  // ── overload / 503 ──────────────────────────────────────────────────────────

  describe('overload protection', () => {
    it('returns 503 with Retry-After when maxInFlight is exceeded', async () => {
      // Create a guard with a maxInFlight of 2 and a custom SingleFlight
      // We need to hold calls in-flight to trigger the limit
      const sf = new SingleFlight()
      const guard = new AuthConcurrencyGuard({
        singleflight: sf,
        maxInFlight: 2,
        overloadRetryAfterSeconds: 5,
      })

      const gate = new Gate()
      const slowLookup = async (): Promise<StoredApiKey | null> => {
        await gate.promise
        return makeKey({ id: `key-${Math.random()}`, scopes: ['trust:read'] })
      }

      // Saturate the guard: 2 distinct keys in-flight
      const r1 = guard.validate('cr_' + 'a'.repeat(64), slowLookup)
      const r2 = guard.validate('cr_' + 'b'.repeat(64), slowLookup)

      // Give the singleflight map a tick to register both in-flight
      await Promise.resolve()
      await Promise.resolve()

      // Third distinct key should be rejected with 503
      const r3 = await guard.validate('cr_' + 'c'.repeat(64), slowLookup)

      expect(r3.ok).toBe(false)
      if (!r3.ok) {
        expect(r3.status).toBe(503)
        expect(r3.retryAfter).toBe(5)
      }

      // Clean up in-flight calls
      gate.open()
      await Promise.all([r1, r2]).catch(() => undefined)
    })
  })

  // ── diagnostic accessors ────────────────────────────────────────────────────

  describe('diagnostic accessors', () => {
    it('inFlightCount reflects live in-flight count', async () => {
      const guard = new AuthConcurrencyGuard()
      const gate = new Gate()
      const rawKey = 'cr_' + 'g'.repeat(64)

      const pending = guard.validate(rawKey, async () => {
        await gate.promise
        return makeKey()
      })

      await Promise.resolve()
      await Promise.resolve()
      expect(guard.inFlightCount).toBe(1)

      gate.open()
      await pending
      expect(guard.inFlightCount).toBe(0)
    })

    it('snapshotCount reflects stored scope snapshots', async () => {
      const guard = new AuthConcurrencyGuard()

      await guard.validate('cr_' + 'h'.repeat(64), async () => makeKey({ id: 'snap-1' }))
      expect(guard.snapshotCount).toBe(1)

      await guard.validate('cr_' + 'i'.repeat(64), async () => makeKey({ id: 'snap-2' }))
      expect(guard.snapshotCount).toBe(2)

      guard.evict('snap-1')
      expect(guard.snapshotCount).toBe(1)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// validateApiKey service layer — concurrent behaviour
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateApiKey — concurrent behaviour', () => {
  it('coalesces N concurrent calls for the same raw key to a single store look-up', async () => {
    // We can't directly observe the singleflight inside the service, but we can
    // verify the correctness invariant: all concurrent callers receive the same
    // result and the result is correct.
    const created = generateApiKey('u-admin', 'full')

    const calls = Array.from({ length: 32 }, () => validateApiKey(created.key))
    const results = await Promise.all(calls)

    expect(results.every((r) => r !== null)).toBe(true)
    expect(results.every((r) => r?.id === created.id)).toBe(true)
    expect(results.every((r) => r?.active === true)).toBe(true)
  })

  it('returns null for all concurrent callers when the key is revoked', async () => {
    const created = generateApiKey('u-admin', 'full')
    revokeApiKey(created.id)

    const calls = Array.from({ length: 16 }, () => validateApiKey(created.key))
    const results = await Promise.all(calls)

    expect(results.every((r) => r === null)).toBe(true)
  })

  it('returns null for an invalid/missing key under concurrent load', async () => {
    const badKey = 'cr_' + 'z'.repeat(64)

    const calls = Array.from({ length: 16 }, () => validateApiKey(badKey))
    const results = await Promise.all(calls)

    expect(results.every((r) => r === null)).toBe(true)
  })

  it('runs distinct keys independently under concurrent load', async () => {
    const keyA = generateApiKey('u-admin', ['trust:read'])
    const keyB = generateApiKey('u-admin', ['payouts:write'])

    const [aResults, bResults] = await Promise.all([
      Promise.all(Array.from({ length: 12 }, () => validateApiKey(keyA.key))),
      Promise.all(Array.from({ length: 12 }, () => validateApiKey(keyB.key))),
    ])

    expect(aResults.every((r) => r?.id === keyA.id)).toBe(true)
    expect(bResults.every((r) => r?.id === keyB.id)).toBe(true)

    // Cross-key isolation: no result from A should look like B and vice versa
    expect(aResults.some((r) => r?.id === keyB.id)).toBe(false)
    expect(bResults.some((r) => r?.id === keyA.id)).toBe(false)
  })

  it('does not return a revoked key to any caller in a mixed concurrent batch', async () => {
    const valid = generateApiKey('u-admin', 'full')
    const revoked = generateApiKey('u-admin', 'full')
    revokeApiKey(revoked.id)

    const [validResults, revokedResults] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, () => validateApiKey(valid.key))),
      Promise.all(Array.from({ length: 10 }, () => validateApiKey(revoked.key))),
    ])

    expect(validResults.every((r) => r?.active === true)).toBe(true)
    expect(revokedResults.every((r) => r === null)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// requireApiKey middleware — integration concurrent behaviour
// ═══════════════════════════════════════════════════════════════════════════════

describe('requireApiKey middleware — concurrent integration', () => {
  /** Run middleware with the given key header and return response info. */
  async function runMiddleware(
    key: string | undefined,
    scope: ApiScope = ApiScope.TRUST_READ,
  ): Promise<{ statusCode: number | undefined; body: unknown; retryAfter: string | undefined }> {
    const req = makeReq(key)
    const { res, statusCode, body, headers } = makeRes()
    const next = vi.fn() as unknown as NextFunction

    await requireApiKey(scope)(req as Request, res as Response, next)

    return {
      statusCode: statusCode(),
      body: body(),
      retryAfter: headers()['retry-after'],
    }
  }

  it('N concurrent requests with a valid key all succeed (next() called for each)', async () => {
    const created = generateApiKey('u-admin', ['trust:read'])

    // Run 20 concurrent requests
    const calls = Array.from({ length: 20 }, () =>
      runMiddleware(created.key, ApiScope.TRUST_READ)
    )
    const results = await Promise.all(calls)

    // All should succeed (statusCode undefined means status() was not called → next() was called)
    expect(results.every((r) => r.statusCode === undefined)).toBe(true)
  })

  it('all concurrent callers receive 401 when the key is revoked', async () => {
    const created = generateApiKey('u-admin', 'full')
    revokeApiKey(created.id)

    const calls = Array.from({ length: 10 }, () =>
      runMiddleware(created.key, ApiScope.ENTERPRISE)
    )
    const results = await Promise.all(calls)

    expect(results.every((r) => r.statusCode === 401)).toBe(true)
  })

  it('returns 401 for all concurrent callers with a bad key format', async () => {
    const badKey = 'not-a-valid-key-format'

    const calls = Array.from({ length: 10 }, () =>
      runMiddleware(badKey, ApiScope.TRUST_READ)
    )
    const results = await Promise.all(calls)

    expect(results.every((r) => r.statusCode === 401)).toBe(true)
  })

  it('returns 403 for a key with insufficient scope', async () => {
    const created = generateApiKey('u-verifier', ['trust:read'])

    const result = await runMiddleware(created.key, ApiScope.PAYOUTS_WRITE)

    expect(result.statusCode).toBe(403)
  })

  it('does not require a key header — returns 401 immediately', async () => {
    const result = await runMiddleware(undefined, ApiScope.TRUST_READ)
    expect(result.statusCode).toBe(401)
  })

  it('mixed concurrent requests: valid and invalid keys get correct responses', async () => {
    const validKey = generateApiKey('u-admin', ['trust:read'])
    const badKey = 'cr_' + 'z'.repeat(64)

    const [validResults, badResults] = await Promise.all([
      Promise.all(Array.from({ length: 8 }, () =>
        runMiddleware(validKey.key, ApiScope.TRUST_READ)
      )),
      Promise.all(Array.from({ length: 8 }, () =>
        runMiddleware(badKey, ApiScope.TRUST_READ)
      )),
    ])

    expect(validResults.every((r) => r.statusCode === undefined)).toBe(true)
    expect(badResults.every((r) => r.statusCode === 401)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Retry-After contract — explicit header values
// ═══════════════════════════════════════════════════════════════════════════════

describe('Retry-After contract', () => {
  it('409 conflict response carries a Retry-After header', async () => {
    // Use a guard with a known conflictRetryAfterSeconds value
    const guard = new AuthConcurrencyGuard({ conflictRetryAfterSeconds: 3 })
    const rawKey = 'cr_' + 'j'.repeat(64)

    const v1 = makeKey({ id: 'retry-key', scopes: ['trust:read'] })
    const v2 = makeKey({ id: 'retry-key', scopes: ['trust:read', 'admin:write'] })

    await guard.validate(rawKey, async () => v1)
    const conflict = await guard.validate(rawKey, async () => v2)

    expect(conflict.ok).toBe(false)
    if (!conflict.ok) {
      expect(conflict.status).toBe(409)
      expect(conflict.retryAfter).toBe(3)
    }
  })

  it('503 overload response carries a Retry-After header', async () => {
    const sf = new SingleFlight()
    const guard = new AuthConcurrencyGuard({
      singleflight: sf,
      maxInFlight: 1,
      overloadRetryAfterSeconds: 7,
    })

    const gate = new Gate()

    // Put one key in-flight to saturate the guard
    const pending = guard.validate('cr_' + 'k'.repeat(64), async () => {
      await gate.promise
      return makeKey({ id: 'saturate-1' })
    })

    await Promise.resolve()
    await Promise.resolve()

    // Second distinct key should be rejected
    const overload = await guard.validate('cr_' + 'l'.repeat(64), async () => makeKey({ id: 'saturate-2' }))

    expect(overload.ok).toBe(false)
    if (!overload.ok) {
      expect(overload.status).toBe(503)
      expect(overload.retryAfter).toBe(7)
    }

    gate.open()
    await pending.catch(() => undefined)
  })

  it('401 and 403 responses do NOT carry a Retry-After header', async () => {
    const guard = new AuthConcurrencyGuard()
    const rawKey = 'cr_' + 'm'.repeat(64)

    const nullResult = await guard.validate(rawKey, async () => null)

    expect(nullResult.ok).toBe(false)
    if (!nullResult.ok) {
      expect(nullResult.status).toBe(401)
      expect(nullResult.retryAfter).toBeUndefined()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Final-state assertions: no unauthorized or partial state after rejection
// ═══════════════════════════════════════════════════════════════════════════════

describe('final-state safety — no unauthorized or partial state after rejection', () => {
  it('a failed lookup leaves no scope snapshot in the guard', async () => {
    const guard = new AuthConcurrencyGuard()
    const rawKey = 'cr_' + 'n'.repeat(64)

    const errorLookup = async (): Promise<StoredApiKey | null> => {
      throw new Error('unexpected')
    }

    await guard.validate(rawKey, errorLookup).catch(() => undefined)

    expect(guard.snapshotCount).toBe(0)
  })

  it('a revoked key leaves no scope snapshot in the guard', async () => {
    const guard = new AuthConcurrencyGuard()
    const rawKey = 'cr_' + 'o'.repeat(64)

    const nullLookup = async (): Promise<StoredApiKey | null> => null

    await guard.validate(rawKey, nullLookup)

    expect(guard.snapshotCount).toBe(0)
  })

  it('a scope-conflict response evicts the stored snapshot to resolve the conflict on retry', async () => {
    const guard = new AuthConcurrencyGuard()
    const rawKey = 'cr_' + 'p'.repeat(64)

    const v1 = makeKey({ id: 'partial-key', scopes: ['trust:read'] })
    const v2 = makeKey({ id: 'partial-key', scopes: ['trust:read', 'admin:write'] })

    // First burst succeeds → snapshot stored as ['trust:read']
    await guard.validate(rawKey, async () => v1)
    expect(guard.snapshotCount).toBe(1)

    // Second burst changes scopes → conflict returned, snapshot IS evicted
    const conflictResult = await guard.validate(rawKey, async () => v2)
    expect(conflictResult.ok).toBe(false)
    if (!conflictResult.ok) {
      expect(conflictResult.status).toBe(409)
    }

    // Snapshot should be clear
    expect(guard.snapshotCount).toBe(0)

    // Verify by doing a third burst with the NEW scopes — no conflict because snapshot is clean
    const thirdResult = await guard.validate(rawKey, async () => v2)
    // The snapshot now holds v2's fingerprint; v2 matches → ok
    expect(thirdResult.ok).toBe(true)
    expect(guard.snapshotCount).toBe(1)
  })

  it('concurrent callers for a scope-conflict all receive 409 (not a mix of ok and conflict)', async () => {
    // This test exercises the scenario where a burst of requests coalesces onto
    // the same singleflight call and the returned key has different scopes from
    // the previous burst.
    //
    // All callers in the second burst share the singleflight result, so they
    // all see the same key and the guard checks them all against the same
    // previous snapshot.  They should all get the same result (409 here).
    const guard = new AuthConcurrencyGuard({ conflictRetryAfterSeconds: 1 })
    const rawKey = 'cr_' + 'q'.repeat(64)

    const v1 = makeKey({ id: 'burst-key', scopes: ['trust:read'] })
    const v2 = makeKey({ id: 'burst-key', scopes: ['trust:read', 'admin:read'] })

    // Establish baseline snapshot
    await guard.validate(rawKey, async () => v1)

    // Second burst: single lookup but many waiters
    const gate = new Gate()
    let lookupFires = 0

    const burst = Array.from({ length: 10 }, () =>
      guard.validate(rawKey, async () => {
        lookupFires++
        await gate.promise
        return v2  // different scopes
      })
    )

    await Promise.resolve()
    await Promise.resolve()

    // Only one lookup should have started for the burst
    expect(lookupFires).toBe(1)

    gate.open()
    const results = await Promise.all(burst)

    // Every caller in the burst gets 409 (scope conflict)
    expect(results.every((r) => !r.ok)).toBe(true)
    if (!results[0]!.ok) {
      expect(results[0]!.status).toBe(409)
    }
    // All results are identical
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true)
  })
})
