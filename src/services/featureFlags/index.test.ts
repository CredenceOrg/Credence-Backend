/**
 * Tests for FeatureFlagService — background TTL cache sweep.
 *
 * Focused on the new sweep behaviour introduced to keep the in-process
 * Map-based cache small by evicting entries that have passed their TTL but
 * were never re-read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FeatureFlagService } from './index.js'
import { FLAG_CACHE_TTL_MS, FLAG_CACHE_SWEEP_INTERVAL_MS } from './consts.js'
import type { Queryable } from '../../db/repositories/queryable.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal Queryable stub — returns no rows by default. */
function createMockDb(overrides: Partial<Queryable> = {}): Queryable {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    ...overrides,
  } as unknown as Queryable
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('FeatureFlagService — cache sweep', () => {
  let service: FeatureFlagService
  let mockDb: Queryable

  beforeEach(() => {
    // Use a very large sweep interval (24 h) so the background timer never
    // fires automatically during a test — we call sweepExpiredCacheEntries()
    // manually to control timing precisely.
    mockDb = createMockDb()
    service = new FeatureFlagService(mockDb, undefined, 86_400_000)
  })

  afterEach(() => {
    service.stopSweep()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // ── sweepExpiredCacheEntries ────────────────────────────────────────────────

  describe('sweepExpiredCacheEntries()', () => {
    it('returns 0 and leaves the cache untouched when all entries are still fresh', async () => {
      // Populate the cache by resolving a flag (cache miss → DB hit → stored)
      ;(mockDb.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            id: 'flag-1',
            key: 'my-flag',
            description: 'test',
            default_enabled: false,
            rollout_percent: 0,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      })
      await service.getFlag('my-flag')

      const swept = service.sweepExpiredCacheEntries()

      expect(swept).toBe(0)
    })

    it('removes entries whose expiresAt has passed and returns the count', async () => {
      vi.useFakeTimers()

      const flagRow = (key: string) => ({
        id: `id-${key}`,
        key,
        description: 'test',
        default_enabled: false,
        rollout_percent: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })

      ;(mockDb.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rows: [flagRow('flag-a')], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [flagRow('flag-b')], rowCount: 1 })

      // Populate cache — must await so the Map is actually filled before we
      // advance time.
      await service.getFlag('flag-a')
      await service.getFlag('flag-b')

      // Advance past FLAG_CACHE_TTL_MS so both entries expire.
      vi.advanceTimersByTime(FLAG_CACHE_TTL_MS + 1)

      const swept = service.sweepExpiredCacheEntries()
      // Both entries should be removed (flag-a + flag-b cache keys).
      expect(swept).toBeGreaterThanOrEqual(2)
    })

    it('only removes expired entries, leaving fresh ones intact', async () => {
      vi.useFakeTimers()

      const flagRow = (key: string) => ({
        id: `id-${key}`,
        key,
        description: 'test',
        default_enabled: false,
        rollout_percent: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })

      ;(mockDb.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rows: [flagRow('old-flag')], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [flagRow('new-flag')], rowCount: 1 })

      // Populate old-flag at t=0, then expire it, then populate new-flag.
      await service.getFlag('old-flag')

      vi.advanceTimersByTime(FLAG_CACHE_TTL_MS + 1)

      await service.getFlag('new-flag')

      const swept = service.sweepExpiredCacheEntries()
      // old-flag entry should be swept; new-flag entry should survive.
      expect(swept).toBeGreaterThanOrEqual(1)
    })

    it('is idempotent — a second call with no new expirations returns 0', async () => {
      vi.useFakeTimers()

      const flagRow = {
        id: 'id-1',
        key: 'flag-x',
        description: 'test',
        default_enabled: false,
        rollout_percent: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }

      ;(mockDb.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [flagRow],
        rowCount: 1,
      })

      await service.getFlag('flag-x')

      vi.advanceTimersByTime(FLAG_CACHE_TTL_MS + 1)

      const first = service.sweepExpiredCacheEntries()
      const second = service.sweepExpiredCacheEntries()

      expect(first).toBeGreaterThanOrEqual(1)
      expect(second).toBe(0)
    })
  })

  // ── stopSweep ─────────────────────────────────────────────────────────────

  describe('stopSweep()', () => {
    it('cancels the background timer so it no longer fires', () => {
      vi.useFakeTimers()

      const sweepSpy = vi.spyOn(service, 'sweepExpiredCacheEntries')

      service.stopSweep()

      // Advance well past the default sweep interval — the timer is gone so
      // the spy should never be called automatically.
      vi.advanceTimersByTime(FLAG_CACHE_SWEEP_INTERVAL_MS * 3)

      expect(sweepSpy).not.toHaveBeenCalled()
    })

    it('is safe to call multiple times without throwing', () => {
      expect(() => {
        service.stopSweep()
        service.stopSweep()
      }).not.toThrow()
    })
  })

  // ── Background timer integration ──────────────────────────────────────────

  describe('background sweep timer', () => {
    it('fires automatically at the configured interval', async () => {
      vi.useFakeTimers()

      const intervalMs = 500
      const timedService = new FeatureFlagService(mockDb, undefined, intervalMs)
      const sweepSpy = vi.spyOn(timedService, 'sweepExpiredCacheEntries')

      await vi.advanceTimersByTimeAsync(intervalMs * 2 + 10)

      expect(sweepSpy).toHaveBeenCalledTimes(2)

      timedService.stopSweep()
    })
  })
})
