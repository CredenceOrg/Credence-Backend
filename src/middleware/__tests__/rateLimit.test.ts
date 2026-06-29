/**
 * Unit tests for the rate-limit fixed-window token bucket.
 *
 * Design constraints
 * ──────────────────
 * • No Date.now() — all time is controlled via vi.useFakeTimers / vi.setSystemTime.
 * • No Math.random() — all randomness-dependent identifiers are supplied
 *   explicitly through request headers or getRedis injection.
 * • Redis is fully in-process via a deterministic fake that mirrors the
 *   incr / expire / ttl contract consumed by checkWindow.
 * • Unit tests live here (affected module); broader integration/route tests
 *   live under tests/routes/rateLimit.test.ts.
 *
 * Behaviours covered
 * ──────────────────
 * Burst        — tokens consumed rapidly up to the burst limit (happy + sad)
 * Refill       — tokens replenish correctly after the window rolls over
 * Per-tier     — free / pro / enterprise tiers get distinct rate limits
 * Prometheus   — rate_limit_hits_total and rate_limit_rejected_total counters
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import {
  createRateLimitMiddleware,
  resolveTierLimit,
  rateLimitRejectedTotal,
  rateLimitHitsTotal,
} from '../rateLimit.js'
import type { Config } from '../../config/index.js'
import type { SubscriptionTier } from '../../services/apiKeys.js'

// ── Deterministic in-memory Redis fake ───────────────────────────────────────

/**
 * Minimal Redis fake that implements the exact interface consumed by
 * checkWindow: incr, expire, ttl.
 *
 * Keys and their TTL offsets are stored in plain Maps so each test can
 * inspect state directly without network or timer side-effects.
 */
class FakeRedis {
  private readonly counts = new Map<string, number>()
  private readonly ttls   = new Map<string, number>()

  async incr(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, next)
    return next
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.ttls.set(key, seconds)
  }

  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -1
  }

  /** Reset all state between tests. */
  flush(): void {
    this.counts.clear()
    this.ttls.clear()
  }

  /** Peek at the current count for a key (test introspection only). */
  count(key: string): number {
    return this.counts.get(key) ?? 0
  }
}

const fakeRedis = new FakeRedis()

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config['rateLimit']> = {}): Config['rateLimit'] {
  return {
    enabled:     true,
    windowSec:   60,
    maxFree:     5,
    maxPro:      20,
    maxEnterprise: 100,
    failOpen:    true,
    ...overrides,
  }
}

/**
 * Build a minimal Express app with the rate-limit middleware wired in.
 * The fake Redis instance is always injected so no live Redis is needed.
 *
 * When `max` is provided and no explicit `config` is supplied, all tier
 * ceilings are set to `max` so the limit header reflects what you'd expect
 * (mirrors the same pattern in tests/routes/rateLimit.test.ts).
 */
function buildApp(opts: {
  config?:       Partial<Config['rateLimit']>
  max?:          number
  namespace?:    string
  tier?:         SubscriptionTier
  keyId?:        string
  ownerId?:      string
  getTenantId?:  (req: Request) => string | undefined
} = {}) {
  const tierOverride =
    opts.max !== undefined
      ? { maxFree: opts.max, maxPro: opts.max, maxEnterprise: opts.max }
      : {}
  const cfg = makeConfig({ ...tierOverride, ...opts.config })

  const app = express()
  app.use(express.json())

  // Attach an apiKeyRecord when tier/keyId/ownerId are provided so the
  // middleware can resolve both the tier ceiling and the per-key bucket.
  if (opts.tier || opts.keyId || opts.ownerId) {
    app.use((req, _res, next) => {
      ;(req as any).apiKeyRecord = {
        id:      opts.keyId  ?? 'key-default',
        ownerId: opts.ownerId ?? 'owner-default',
        tier:    opts.tier   ?? 'free',
      }
      next()
    })
  }

  app.use(
    '/api',
    createRateLimitMiddleware(cfg, {
      namespace:    opts.namespace ?? 'unit:test',
      max:          opts.max,
      getRedis:     () => fakeRedis,
      getTenantId:  opts.getTenantId,
    }),
  )
  app.get('/api/ping', (_req, res) => res.json({ ok: true }))
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({
      error:   err.message,
      code:    err.code,
      details: err.details,
    })
  })
  return app
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  fakeRedis.flush()
  // Do NOT call register.resetMetrics() here — it deregisters the module-level
  // Prometheus counters (rateLimitRejectedTotal, rateLimitHitsTotal) that are
  // created once at import time and cannot be re-registered. Prometheus tests
  // track deltas instead (capture "before" value, assert "after > before").
})

afterEach(() => {
  vi.useRealTimers()
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. BURST BEHAVIOUR
// ═════════════════════════════════════════════════════════════════════════════

/**
 * "Burst" is the ability to consume the full window budget in rapid succession.
 * All requests within the same window succeed up to the limit; the very next
 * one is rejected, and subsequent ones stay rejected for the remainder of the
 * window.
 */
describe('burst behaviour', () => {
  it('token_bucket_allows_full_burst_up_to_limit', async () => {
    const max = 3
    const app = buildApp({ max, namespace: 'unit:burst:happy' })

    for (let i = 0; i < max; i++) {
      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(200)
    }
  })

  it('token_bucket_rejects_request_when_burst_limit_is_exceeded', async () => {
    const max = 3
    const app = buildApp({ max, namespace: 'unit:burst:sad' })

    for (let i = 0; i < max; i++) {
      await request(app).get('/api/ping')
    }

    const blocked = await request(app).get('/api/ping')
    expect(blocked.status).toBe(429)
    expect(blocked.body.code).toBe('rate_limit_exceeded')
    expect(blocked.body.details).toMatchObject({ limit: max })
  })

  it('token_bucket_rejects_all_subsequent_requests_after_burst_exhausted', async () => {
    const max = 2
    const app = buildApp({ max, namespace: 'unit:burst:sustained' })

    await request(app).get('/api/ping')
    await request(app).get('/api/ping')

    // Three more attempts — all must be blocked within the same window.
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(429)
    }
  })

  it('token_bucket_remaining_header_decrements_with_each_burst_request', async () => {
    const max = 4
    const app = buildApp({ max, namespace: 'unit:burst:headers' })

    const r1 = await request(app).get('/api/ping')
    expect(r1.headers['x-ratelimit-limit']).toBe(String(max))
    expect(r1.headers['x-ratelimit-remaining']).toBe('3')

    const r2 = await request(app).get('/api/ping')
    expect(r2.headers['x-ratelimit-remaining']).toBe('2')

    const r3 = await request(app).get('/api/ping')
    expect(r3.headers['x-ratelimit-remaining']).toBe('1')

    const r4 = await request(app).get('/api/ping')
    expect(r4.headers['x-ratelimit-remaining']).toBe('0')
  })

  it('token_bucket_sets_retry_after_header_when_burst_limit_is_exceeded', async () => {
    const max = 1
    const app = buildApp({ max, namespace: 'unit:burst:retry-after' })

    await request(app).get('/api/ping')
    const blocked = await request(app).get('/api/ping')

    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. REFILL BEHAVIOUR
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The fixed-window counter "refills" by moving to a new window key when the
 * clock crosses a window boundary. vi.setSystemTime controls Date.now() so
 * no real wall-clock time elapses.
 */
describe('refill behaviour', () => {
  const windowSec   = 60
  // Anchor to a known epoch-aligned window far from any edge.
  const windowStart = 1_700_004_000 // already a multiple of 60
  const lastSecOfN  = (windowStart + windowSec - 1) * 1000
  const firstSecOfN1 = (windowStart + windowSec)   * 1000

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(lastSecOfN) // start every refill test inside window N
  })

  it('token_bucket_refills_after_window_rolls_over', async () => {
    const max = 2
    const app = buildApp({
      max,
      namespace: 'unit:refill:basic',
      config: { windowSec },
    })

    // Exhaust window N.
    for (let i = 0; i < max; i++) {
      expect((await request(app).get('/api/ping')).status).toBe(200)
    }
    expect((await request(app).get('/api/ping')).status).toBe(429)

    // Advance clock into window N+1 — a new Redis key is produced, so the
    // counter starts from zero again.
    vi.setSystemTime(firstSecOfN1)

    for (let i = 0; i < max; i++) {
      expect((await request(app).get('/api/ping')).status).toBe(200)
    }
    expect((await request(app).get('/api/ping')).status).toBe(429)
  })

  it('token_bucket_does_not_refill_before_window_boundary', async () => {
    const max = 1
    const app = buildApp({
      max,
      namespace: 'unit:refill:premature',
      config: { windowSec },
    })

    // Exhaust budget at the start of the last second of window N.
    expect((await request(app).get('/api/ping')).status).toBe(200)
    expect((await request(app).get('/api/ping')).status).toBe(429)

    // Advance one millisecond — still inside window N.
    vi.setSystemTime(lastSecOfN + 500)

    // Must remain blocked — no refill yet.
    expect((await request(app).get('/api/ping')).status).toBe(429)
  })

  it('token_bucket_refills_exactly_at_window_boundary', async () => {
    const max = 1
    const app = buildApp({
      max,
      namespace: 'unit:refill:exact-boundary',
      config: { windowSec },
    })

    expect((await request(app).get('/api/ping')).status).toBe(200)
    expect((await request(app).get('/api/ping')).status).toBe(429)

    // Advance to the exact first millisecond of window N+1.
    vi.setSystemTime(firstSecOfN1)

    // Budget is fully restored.
    expect((await request(app).get('/api/ping')).status).toBe(200)
  })

  it('token_bucket_independent_windows_do_not_share_counts', async () => {
    const max = 2
    const app = buildApp({
      max,
      namespace: 'unit:refill:isolation',
      config: { windowSec },
    })

    // Consume 1 request in window N.
    expect((await request(app).get('/api/ping')).status).toBe(200)

    // Roll into window N+1 — the NEW window starts at 0, not at 1.
    vi.setSystemTime(firstSecOfN1)

    // Should have the full budget of max=2 again, not max-1=1.
    expect((await request(app).get('/api/ping')).status).toBe(200)
    expect((await request(app).get('/api/ping')).status).toBe(200)
    expect((await request(app).get('/api/ping')).status).toBe(429)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. PER-TIER OVERRIDES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * resolveTierLimit maps the subscription tier onto the correct config value.
 * The middleware then enforces that resolved limit as the tenant ceiling.
 */
describe('per-tier overrides', () => {
  // ── resolveTierLimit unit tests (pure function, no HTTP) ──────────────────

  describe('resolveTierLimit', () => {
    it('tier_limit_returns_maxFree_for_free_tier', () => {
      const cfg = makeConfig({ maxFree: 10, maxPro: 50, maxEnterprise: 200 })
      expect(resolveTierLimit('free', cfg)).toBe(10)
    })

    it('tier_limit_returns_maxPro_for_pro_tier', () => {
      const cfg = makeConfig({ maxFree: 10, maxPro: 50, maxEnterprise: 200 })
      expect(resolveTierLimit('pro', cfg)).toBe(50)
    })

    it('tier_limit_returns_maxEnterprise_for_enterprise_tier', () => {
      const cfg = makeConfig({ maxFree: 10, maxPro: 50, maxEnterprise: 200 })
      expect(resolveTierLimit('enterprise', cfg)).toBe(200)
    })

    it('tier_limit_defaults_to_maxFree_for_unknown_tier', () => {
      const cfg = makeConfig({ maxFree: 7, maxPro: 50, maxEnterprise: 200 })
      // Cast to bypass TS — exercises the default branch in the switch.
      expect(resolveTierLimit('unknown' as SubscriptionTier, cfg)).toBe(7)
    })
  })

  // ── Middleware enforcement per tier ───────────────────────────────────────

  it('free_tier_is_blocked_at_maxFree_limit', async () => {
    const app = buildApp({
      namespace: 'unit:tier:free',
      config: { maxFree: 2, maxPro: 20, maxEnterprise: 100 },
      tier:    'free',
    })

    // Use up the free budget.
    for (let i = 0; i < 2; i++) {
      expect((await request(app).get('/api/ping')).status).toBe(200)
    }
    expect((await request(app).get('/api/ping')).status).toBe(429)
  })

  it('pro_tier_allows_more_requests_than_free_tier', async () => {
    const app = buildApp({
      namespace: 'unit:tier:pro',
      config: { maxFree: 2, maxPro: 5, maxEnterprise: 100 },
      tier:    'pro',
    })

    // Use up the pro budget.
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/ping')).status).toBe(200)
    }
    expect((await request(app).get('/api/ping')).status).toBe(429)
  })

  it('enterprise_tier_allows_more_requests_than_pro_tier', async () => {
    const app = buildApp({
      namespace:  'unit:tier:enterprise',
      config:     { maxFree: 2, maxPro: 5, maxEnterprise: 8 },
      tier:       'enterprise',
    })

    for (let i = 0; i < 8; i++) {
      expect((await request(app).get('/api/ping')).status).toBe(200)
    }
    expect((await request(app).get('/api/ping')).status).toBe(429)
  })

  it('free_tier_request_is_rejected_before_pro_limit_is_reached', async () => {
    // A free-tier caller should be blocked at maxFree even if maxPro is
    // far higher — confirming per-tier enforcement is applied, not a
    // shared global ceiling.
    const cfg = { maxFree: 1, maxPro: 50, maxEnterprise: 200 }

    const freeApp = buildApp({ namespace: 'unit:tier:free-vs-pro:free', config: cfg, tier: 'free' })

    expect((await request(freeApp).get('/api/ping')).status).toBe(200)
    const blocked = await request(freeApp).get('/api/ping')
    expect(blocked.status).toBe(429)
    // The limit reported in the error details matches the free-tier ceiling.
    expect(blocked.body.details).toMatchObject({ limit: 1 })
  })

  it('different_tiers_operate_independently_on_separate_tenant_buckets', async () => {
    // Two separate apps, same config, different tiers — each exhausts its
    // own bucket without affecting the other.
    const cfg = { maxFree: 1, maxPro: 3, maxEnterprise: 10 }

    const freeApp = buildApp({
      namespace: 'unit:tier:separation:free',
      config:    cfg,
      tier:      'free',
      ownerId:   'owner-free',
    })
    const proApp = buildApp({
      namespace: 'unit:tier:separation:pro',
      config:    cfg,
      tier:      'pro',
      ownerId:   'owner-pro',
    })

    // Block the free-tier caller.
    expect((await request(freeApp).get('/api/ping')).status).toBe(200)
    expect((await request(freeApp).get('/api/ping')).status).toBe(429)

    // Pro-tier caller is unaffected — its own budget is intact.
    for (let i = 0; i < 3; i++) {
      expect((await request(proApp).get('/api/ping')).status).toBe(200)
    }
    expect((await request(proApp).get('/api/ping')).status).toBe(429)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. PROMETHEUS COUNTERS (existing coverage, extended)
// ═════════════════════════════════════════════════════════════════════════════

describe('prometheus counter behaviour', () => {
  it('rate_limit_hits_total_increments_for_tenant_quota_exceeded', async () => {
    const app = buildApp({
      max:       1,
      namespace: 'unit:prom:tenant',
      ownerId:   'owner-prom-tenant',
    })

    const before = (await rateLimitHitsTotal.get()).values
      .reduce((sum, v) => sum + v.value, 0)

    await request(app).get('/api/ping') // allowed
    await request(app).get('/api/ping') // rejected → increments rate_limit_hits_total

    const after = (await rateLimitHitsTotal.get()).values
      .reduce((sum, v) => sum + v.value, 0)

    expect(after).toBeGreaterThan(before)
  })

  it('rate_limit_rejected_total_increments_with_tenant_limit_reason', async () => {
    const app = buildApp({ max: 1, namespace: 'unit:prom:rejected' })

    const before = (await rateLimitRejectedTotal.get()).values
      .filter(v => v.labels.reason === 'tenant_limit')
      .reduce((sum, v) => sum + v.value, 0)

    await request(app).get('/api/ping') // allowed
    await request(app).get('/api/ping') // rejected

    const after = (await rateLimitRejectedTotal.get()).values
      .filter(v => v.labels.reason === 'tenant_limit')
      .reduce((sum, v) => sum + v.value, 0)

    expect(after).toBeGreaterThan(before)
  })

  it('rate_limit_hits_total_uses_unknown_tenant_when_no_identity_present', async () => {
    // A request with no API key, no auth header, no user → tenant="unknown".
    // We verify that the counter is incremented with that label by checking
    // the delta on the counter object directly (avoids raw metrics-string
    // fragility and doesn't depend on register.resetMetrics()).
    const app = buildApp({ max: 1, namespace: 'unit:prom:unknown-tenant' })

    const before = (await rateLimitHitsTotal.get()).values
      .filter(v => v.labels.tenant === 'unknown')
      .reduce((sum, v) => sum + v.value, 0)

    await request(app).get('/api/ping')   // allowed  — no increment yet
    await request(app).get('/api/ping')   // rejected — increments hits with tenant="unknown"

    const after = (await rateLimitHitsTotal.get()).values
      .filter(v => v.labels.tenant === 'unknown')
      .reduce((sum, v) => sum + v.value, 0)

    expect(after).toBeGreaterThan(before)
  })
})
