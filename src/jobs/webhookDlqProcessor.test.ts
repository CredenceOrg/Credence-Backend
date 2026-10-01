/**
 * Boundary, rejection, and recovery tests for WebhookDlqProcessor.
 *
 * The suite is built around fake DLQ/Webhook stores and a stubbed delivery
 * layer so every clock edge, malformed row, store failure, and concurrency
 * interleaving is reachable deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  WebhookDlqProcessor,
  processWebhookDlq,
  validateDlqEntry,
  type DlqSkipReason,
} from './webhookDlqProcessor.js'
import type { DlqEntry, DlqStore, WebhookConfig, WebhookStore } from '../services/webhooks/types.js'

// ── Delivery layer stub ───────────────────────────────────────────────────────
// deliverWebhook performs real network I/O; replace it so delivery outcomes are
// fully controlled while the processor's own logic is exercised unchanged.
const deliverWebhookMock = vi.hoisted(() => vi.fn())

vi.mock('../services/webhooks/delivery.js', () => ({
  deliverWebhook: deliverWebhookMock,
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-03-01T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

function makeEntry(overrides: Partial<DlqEntry> = {}): DlqEntry {
  return {
    id: 'dlq_1',
    webhookId: 'wh_1',
    payload: {
      event: 'bond.created',
      timestamp: '2026-02-28T00:00:00.000Z',
      data: {
        address: 'GABC',
        bondedAmount: '100',
        bondStart: null,
        bondDuration: null,
        active: true,
      },
    },
    failedAt: new Date(NOW - 2 * HOUR).toISOString(),
    attempts: 3,
    lastStatusCode: 503,
    lastError: 'Service Unavailable',
    ...overrides,
  }
}

function makeWebhook(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    id: 'wh_1',
    url: 'https://hooks.example.com/credence',
    events: ['bond.created'],
    secret: 'super-secret-value',
    secretUpdatedAt: new Date(NOW - 30 * 24 * HOUR),
    active: true,
    ...overrides,
  }
}

interface FakeStore {
  store: DlqStore
  entries: DlqEntry[]
  markReplayed: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
}

function makeDlqStore(initial: DlqEntry[] = [], overrides: Partial<DlqStore> = {}): FakeStore {
  const entries = [...initial]
  const markReplayed = vi.fn(async (id: string, replayedAt: string) => {
    const idx = entries.findIndex(e => e.id === id)
    if (idx >= 0) entries[idx] = { ...entries[idx], replayedAt }
  })
  const list = vi.fn(async () => entries.map(e => ({ ...e })))
  const store: DlqStore = {
    push: vi.fn(async (entry: DlqEntry) => { entries.push(entry) }),
    list,
    get: vi.fn(async (id: string) => entries.find(e => e.id === id) ?? null),
    markReplayed,
    ...overrides,
  }
  return { store, entries, markReplayed, list }
}

interface FakeWebhookStore {
  store: WebhookStore
  get: ReturnType<typeof vi.fn>
}

function makeWebhookStore(configs: WebhookConfig[] = [], overrides: Partial<WebhookStore> = {}): FakeWebhookStore {
  const get = vi.fn(async (id: string) => configs.find(c => c.id === id) ?? null)
  const store: WebhookStore = {
    getByEvent: vi.fn(async () => configs),
    get,
    set: vi.fn(async () => {}),
    rotateSecret: vi.fn(async () => {
      throw new Error('not implemented in test double')
    }),
    ...overrides,
  }
  return { store, get }
}

const successDelivery = (webhookId: string) => ({
  webhookId,
  success: true,
  statusCode: 200,
  attempts: 1,
})

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('WebhookDlqProcessor', () => {
  let logger: ReturnType<typeof vi.fn>

  beforeEach(() => {
    logger = vi.fn()
    deliverWebhookMock.mockReset()
    deliverWebhookMock.mockImplementation(async (webhook: WebhookConfig) =>
      successDelivery(webhook.id)
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  const build = (
    dlq: FakeStore,
    webhooks: FakeWebhookStore,
    options: Parameters<typeof WebhookDlqProcessor.prototype.constructor>[2] = {},
  ) =>
    new WebhookDlqProcessor(dlq.store, webhooks.store, {
      logger,
      now: () => NOW,
      ...options,
    })

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('successful replay', () => {
    it('replays an eligible entry and marks it replayed at the injected clock', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks).run()

      expect(result).toMatchObject({
        scannedCount: 1,
        eligibleCount: 1,
        replayedCount: 1,
        failedCount: 0,
        skippedCount: 0,
        orphanedCount: 0,
        invalidCount: 0,
        dryRun: false,
        concurrentSkip: false,
      })
      expect(dlq.markReplayed).toHaveBeenCalledExactlyOnceWith('dlq_1', '2026-03-01T12:00:00.000Z')
    })

    it('delivers the entry payload to the owning webhook, not a stale copy', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      const entry = makeEntry()

      await build(dlq, webhooks).run()

      expect(deliverWebhookMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: 'wh_1' }),
        entry.payload,
        {},
      )
    })

    it('marks replayed only after the delivery resolved', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      const order: string[] = []
      deliverWebhookMock.mockImplementation(async (webhook: WebhookConfig) => {
        order.push('deliver')
        return successDelivery(webhook.id)
      })
      dlq.markReplayed.mockImplementation(async () => {
        order.push('mark')
      })

      await build(dlq, webhooks).run()

      // At-least-once invariant: never mark before the send is observed.
      expect(order).toEqual(['deliver', 'mark'])
    })

    it('treats a multi-chunk delivery as replayed only when every chunk succeeds', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      deliverWebhookMock.mockResolvedValue([
        successDelivery('wh_1'),
        { webhookId: 'wh_1', success: false, statusCode: 500, attempts: 1 },
      ])

      const result = await build(dlq, webhooks).run()

      expect(result.replayedCount).toBe(0)
      expect(result.failedCount).toBe(1)
      expect(dlq.markReplayed).not.toHaveBeenCalled()
    })

    it('replays every eligible entry in a mixed backlog', async () => {
      const dlq = makeDlqStore([
        makeEntry({ id: 'dlq_replay' }),
        makeEntry({ id: 'dlq_done', replayedAt: new Date(NOW - HOUR).toISOString() }),
        makeEntry({ id: 'dlq_fresh', failedAt: new Date(NOW - 1000).toISOString() }),
        makeEntry({ id: 'dlq_exhausted', attempts: 99 }),
        makeEntry({ id: 'dlq_corrupt', payload: null as never }),
        makeEntry({ id: 'dlq_orphan', webhookId: 'wh_missing' }),
      ])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks).run()

      // eligibleCount counts entries that cleared the pre-flight gates and
      // were resolved for delivery — the orphan clears those gates too, then
      // fails to resolve a webhook.
      expect(result).toMatchObject({
        scannedCount: 6,
        eligibleCount: 2,
        replayedCount: 1,
        skippedCount: 3,
        orphanedCount: 1,
        invalidCount: 1,
      })
      expect(deliverWebhookMock).toHaveBeenCalledTimes(1)
    })

    it('does not deliver an entry for an inactive webhook', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook({ active: false })])

      const result = await build(dlq, webhooks).run()

      expect(result.eligibleCount).toBe(1)
      expect(result.replayedCount).toBe(0)
      expect(result.skippedCount).toBe(1)
      expect(deliverWebhookMock).not.toHaveBeenCalled()
      expect(dlq.markReplayed).not.toHaveBeenCalled()
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('inactive_webhook'))
    })
  })

  // ── Boundaries ─────────────────────────────────────────────────────────────

  describe('boundaries', () => {
    it('replays an entry whose age is exactly minAgeMs', async () => {
      const dlq = makeDlqStore([makeEntry({ failedAt: new Date(NOW - 60_000).toISOString() })])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks, { minAgeMs: 60_000 }).run()

      expect(result.replayedCount).toBe(1)
    })

    it('defers an entry one millisecond inside the grace period', async () => {
      const dlq = makeDlqStore([makeEntry({ failedAt: new Date(NOW - 59_999).toISOString() })])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks, { minAgeMs: 60_000 }).run()

      expect(result.replayedCount).toBe(0)
      expect(result.eligibleCount).toBe(0)
      expect(result.skippedCount).toBe(1)
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('too_recent'))
    })

    it('replays immediately when minAgeMs is 0', async () => {
      const dlq = makeDlqStore([makeEntry({ failedAt: new Date(NOW).toISOString() })])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks, { minAgeMs: 0 }).run()

      expect(result.replayedCount).toBe(1)
    })

    it('replays an entry at exactly maxReplayAttempts and skips one past it', async () => {
      const dlq = makeDlqStore([
        makeEntry({ id: 'dlq_at_cap', attempts: 5 }),
        makeEntry({ id: 'dlq_over_cap', attempts: 6 }),
      ])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks, { maxReplayAttempts: 5 }).run()

      expect(result.replayedCount).toBe(1)
      expect(result.skippedCount).toBe(1)
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('attempts_exhausted'))
    })

    it('replays an entry with zero recorded attempts', async () => {
      const dlq = makeDlqStore([makeEntry({ attempts: 0 })])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks, { maxReplayAttempts: 0 }).run()

      expect(result.replayedCount).toBe(1)
    })

    it('handles an empty DLQ without touching the webhook store', async () => {
      const dlq = makeDlqStore([])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks).run()

      expect(result.scannedCount).toBe(0)
      expect(result.replayedCount).toBe(0)
      expect(webhooks.get).not.toHaveBeenCalled()
      expect(dlq.markReplayed).not.toHaveBeenCalled()
    })

    it('caps a run at batchSize and defers the remainder to the next run', async () => {
      const dlq = makeDlqStore([
        makeEntry({ id: 'dlq_1' }),
        makeEntry({ id: 'dlq_2' }),
        makeEntry({ id: 'dlq_3' }),
      ])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks, { batchSize: 2 }).run()

      expect(result.eligibleCount).toBe(2)
      expect(result.replayedCount).toBe(2)
      expect(result.skippedCount).toBe(1)
      expect(deliverWebhookMock).toHaveBeenCalledTimes(2)
      // Deferred, never discarded.
      expect(dlq.entries.find(e => e.id === 'dlq_3')?.replayedAt).toBeUndefined()
    })

    it('completes the backlog across successive runs', async () => {
      const dlq = makeDlqStore([
        makeEntry({ id: 'dlq_1' }),
        makeEntry({ id: 'dlq_2' }),
        makeEntry({ id: 'dlq_3' }),
      ])
      const webhooks = makeWebhookStore([makeWebhook()])
      const processor = build(dlq, webhooks, { batchSize: 2 })

      await processor.run()
      const second = await processor.run()

      expect(second.replayedCount).toBe(1)
      expect(dlq.entries.every(e => e.replayedAt !== undefined)).toBe(true)
    })

    it('falls back to defaults for non-finite or out-of-range configuration', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks, {
        batchSize: 0,
        minAgeMs: -1,
        maxReplayAttempts: Number.NaN,
      }).run()

      // batchSize 0 is not a valid cap; the default (100) applies.
      expect(result.replayedCount).toBe(1)
    })

    it('clamps a clock that moves backwards to a non-negative duration', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      let tick = 0
      const processor = new WebhookDlqProcessor(dlq.store, webhooks.store, {
        logger,
        now: () => (tick++ === 0 ? NOW : NOW - 5_000),
      })

      const result = await processor.run()

      expect(result.durationMs).toBe(0)
    })
  })

  // ── Rejection / invalid input ──────────────────────────────────────────────

  describe('rejection of malformed entries', () => {
    const cases: Array<[string, Partial<DlqEntry>]> = [
      ['missing id', { id: '' }],
      ['missing webhookId', { webhookId: '' }],
      ['unparseable failedAt', { failedAt: 'not-a-date' }],
      ['non-numeric attempts', { attempts: 'three' as unknown as number }],
      ['NaN attempts', { attempts: Number.NaN }],
      ['missing payload', { payload: undefined as never }],
      ['payload missing event', { payload: { timestamp: '2026-01-01T00:00:00.000Z', data: {} } as never }],
      ['payload unparseable timestamp', { payload: { event: 'bond.created', timestamp: 'nope', data: {} } as never }],
      ['payload missing data', { payload: { event: 'bond.created', timestamp: '2026-01-01T00:00:00.000Z' } as never }],
    ]

    it.each(cases)('classifies %s as invalid and never delivers it', async (_label, overrides) => {
      const dlq = makeDlqStore([makeEntry(overrides)])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks).run()

      expect(result.invalidCount).toBe(1)
      expect(result.eligibleCount).toBe(0)
      expect(result.replayedCount).toBe(0)
      expect(deliverWebhookMock).not.toHaveBeenCalled()
      expect(dlq.markReplayed).not.toHaveBeenCalled()
    })

    it('validates a well-formed entry', () => {
      expect(validateDlqEntry(makeEntry())).toEqual({ ok: true, payload: makeEntry().payload })
    })

    it('rejects a non-object entry', () => {
      expect(validateDlqEntry(null as never)).toEqual({ ok: false, reason: 'entry_not_an_object' })
    })

    it('keeps an invalid entry in the DLQ for manual inspection', async () => {
      const dlq = makeDlqStore([makeEntry({ id: 'dlq_bad', payload: undefined as never })])

      await build(dlq, makeWebhookStore([makeWebhook()])).run()

      const survivor = dlq.entries.find(e => e.id === 'dlq_bad')
      expect(survivor).toBeDefined()
      expect(survivor?.replayedAt).toBeUndefined()
    })
  })

  // ── Failure and recovery ───────────────────────────────────────────────────

  describe('failure and recovery', () => {
    it('leaves a failed delivery unmarked so the next run retries it', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      deliverWebhookMock.mockResolvedValueOnce({
        webhookId: 'wh_1',
        success: false,
        statusCode: 500,
        attempts: 1,
        error: 'Internal Server Error',
      })

      const processor = build(dlq, webhooks)
      const first = await processor.run()

      expect(first.failedCount).toBe(1)
      expect(dlq.markReplayed).not.toHaveBeenCalled()
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('failed'))

      deliverWebhookMock.mockResolvedValue(successDelivery('wh_1'))
      const second = await processor.run()

      expect(second.replayedCount).toBe(1)
      expect(dlq.markReplayed).toHaveBeenCalledTimes(1)
    })

    it('treats a thrown delivery error as a failed entry, not a failed run', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      deliverWebhookMock.mockRejectedValue(new Error('ECONNREFUSED'))

      const result = await build(dlq, webhooks).run()

      expect(result.failedCount).toBe(1)
      expect(result.scannedCount).toBe(1)
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'))
    })

    it('rejects the run when the DLQ cannot be read', async () => {
      const dlq = makeDlqStore([], {
        list: vi.fn(async () => { throw new Error('connection terminated') }),
      })
      const webhooks = makeWebhookStore([makeWebhook()])
      const processor = build(dlq, webhooks)

      await expect(processor.run()).rejects.toThrow('connection terminated')
      expect(deliverWebhookMock).not.toHaveBeenCalled()
    })

    it('releases the run flag after a DLQ read failure so it can recover', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      dlq.list.mockRejectedValueOnce(new Error('transient outage'))
      const processor = build(dlq, webhooks)

      await expect(processor.run()).rejects.toThrow('transient outage')
      expect(processor.isRunning()).toBe(false)

      const result = await processor.run()

      expect(result.replayedCount).toBe(1)
    })

    it('isolates a webhook-lookup failure to its own entry', async () => {
      const dlq = makeDlqStore([
        makeEntry({ id: 'dlq_boom', webhookId: 'wh_flaky' }),
        makeEntry({ id: 'dlq_ok', webhookId: 'wh_1' }),
      ])
      const webhooks = makeWebhookStore([makeWebhook()])
      webhooks.store.get = vi.fn(async (id: string) => {
        if (id === 'wh_flaky') throw new Error('store unavailable')
        return makeWebhook()
      })

      const result = await build(dlq, webhooks).run()

      expect(result.failedCount).toBe(1)
      expect(result.replayedCount).toBe(1)
      expect(dlq.markReplayed).toHaveBeenCalledExactlyOnceWith('dlq_ok', expect.any(String))
    })

    it('does not mark an entry whose delivery succeeded but whose mark failed', async () => {
      const dlq = makeDlqStore([makeEntry()], {
        markReplayed: vi.fn(async () => { throw new Error('write conflict') }),
      })
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks).run()

      // At-least-once: counted as failed so the delivery is retried rather than
      // being assumed delivered.
      expect(result.replayedCount).toBe(0)
      expect(result.failedCount).toBe(1)
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('mark_replayed_failed'))
    })

    it('recovers an entry after a mark failure on a later run', async () => {
      const markReplayed = vi.fn(async () => { throw new Error('deadlock detected') })
      const dlq = makeDlqStore([makeEntry()], { markReplayed })
      const webhooks = makeWebhookStore([makeWebhook()])
      const processor = build(dlq, webhooks)

      await processor.run()
      markReplayed.mockImplementation(async (id: string, at: string) => {
        const target = dlq.entries.find(e => e.id === id)
        if (target) target.replayedAt = at
      })
      const second = await processor.run()

      expect(second.replayedCount).toBe(1)
      expect(dlq.entries[0].replayedAt).toBe('2026-03-01T12:00:00.000Z')
    })

    it('records a non-Error throwable without losing the run', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      deliverWebhookMock.mockRejectedValueOnce('socket hang up')

      const result = await build(dlq, webhooks).run()

      expect(result.failedCount).toBe(1)
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('socket hang up'))
    })
  })

  // ── Concurrency ────────────────────────────────────────────────────────────

  describe('concurrent execution', () => {
    it('short-circuits a second run while the first is in flight', async () => {
      // The deferred is created up front: run() awaits the DLQ list before it
      // ever reaches the delivery layer, so a release captured lazily inside the
      // mock would never be assigned in time.
      let release: () => void = () => {}
      const gate = new Promise<{ webhookId: string; success: boolean; attempts: number }>(resolve => {
        release = () => resolve(successDelivery('wh_1'))
      })
      deliverWebhookMock.mockImplementation(() => gate)

      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      const processor = build(dlq, webhooks)

      const first = processor.run()
      const second = await processor.run()

      expect(second).toMatchObject({ concurrentSkip: true, scannedCount: 0, replayedCount: 0 })
      expect(processor.isRunning()).toBe(true)
      expect(logger).toHaveBeenCalledWith('[WebhookDlqProcessor] Already running, skipping')

      release()
      expect((await first).replayedCount).toBe(1)
      expect(deliverWebhookMock).toHaveBeenCalledTimes(1)
    })

    it('never delivers the same entry twice when several runs overlap', async () => {
      let release: () => void = () => {}
      const gate = new Promise<{ webhookId: string; success: boolean; attempts: number }>(resolve => {
        release = () => resolve(successDelivery('wh_1'))
      })
      deliverWebhookMock.mockImplementation(() => gate)

      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      const processor = build(dlq, webhooks)

      const runs = Promise.all([processor.run(), processor.run(), processor.run()])
      release()
      const results = await runs

      expect(results.filter(r => r.replayedCount === 1)).toHaveLength(1)
      expect(results.filter(r => r.concurrentSkip)).toHaveLength(2)
      expect(deliverWebhookMock).toHaveBeenCalledTimes(1)
      expect(dlq.markReplayed).toHaveBeenCalledTimes(1)
    })

    it('rejects a second scheduled run while a slow run is still going', async () => {
      const dlq = makeDlqStore([])
      const webhooks = makeWebhookStore([])
      dlq.list.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([]), 50)))
      const processor = build(dlq, webhooks)

      const first = processor.run()
      const second = await processor.run()
      await first

      expect(second.concurrentSkip).toBe(true)
    })

    it('serialises entries within a run, never in parallel', async () => {
      let inFlight = 0
      let maxInFlight = 0
      deliverWebhookMock.mockImplementation(async (webhook: WebhookConfig) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 1))
        inFlight--
        return successDelivery(webhook.id)
      })
      const dlq = makeDlqStore([
        makeEntry({ id: 'dlq_1' }),
        makeEntry({ id: 'dlq_2' }),
        makeEntry({ id: 'dlq_3' }),
      ])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks).run()

      expect(maxInFlight).toBe(1)
      expect(result.replayedCount).toBe(3)
    })
  })

  // ── Dry run ────────────────────────────────────────────────────────────────

  describe('dry run', () => {
    it('classifies without delivering or mutating anything', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks, { dryRun: true }).run()

      expect(result.dryRun).toBe(true)
      expect(result.eligibleCount).toBe(1)
      expect(result.skippedCount).toBe(1)
      expect(deliverWebhookMock).not.toHaveBeenCalled()
      expect(dlq.markReplayed).not.toHaveBeenCalled()
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('dry_run'))
    })
  })

  // ── Observability ──────────────────────────────────────────────────────────

  describe('observability', () => {
    it('emits metrics and a completion summary with counts', async () => {
      const metrics = {
        incRuns: vi.fn(),
        incReplayed: vi.fn(),
        incFailed: vi.fn(),
        incSkipped: vi.fn(),
        observeDuration: vi.fn(),
      }
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])

      await build(dlq, webhooks, { metrics }).run()

      expect(metrics.incRuns).toHaveBeenCalledTimes(1)
      expect(metrics.incReplayed).toHaveBeenCalledWith(1)
      expect(metrics.incFailed).toHaveBeenCalledWith(0)
      expect(metrics.incSkipped).toHaveBeenCalledWith(0)
      expect(metrics.observeDuration).toHaveBeenCalledWith(expect.any(Number))
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('replayed=1 failed=0'))
    })

    it('never writes payload data, urls, or secrets to the log', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([
        makeWebhook({ url: 'https://hooks.example.com/secret-path', secret: 'sk_live_topsecret' }),
      ])

      await build(dlq, webhooks).run()

      const logged = logger.mock.calls.map(args => args.join(' ')).join('\n')
      expect(logged.length).toBeGreaterThan(0)
      expect(logged).not.toContain('sk_live_topsecret')
      expect(logged).not.toContain('secret-path')
      expect(logged).not.toContain('GABC')
    })

    it('works with metrics and logger omitted', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await new WebhookDlqProcessor(dlq.store, webhooks.store, { now: () => NOW }).run()

      expect(result.replayedCount).toBe(1)
    })
  })

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  describe('start/stop', () => {
    it('runs immediately and then on the interval', async () => {
      vi.useFakeTimers()
      const dlq = makeDlqStore([])
      const webhooks = makeWebhookStore([])
      const processor = build(dlq, webhooks, { intervalMs: 1000 })

      processor.start()
      await vi.advanceTimersByTimeAsync(1000)

      // One immediate run plus one scheduled tick.
      expect(dlq.list).toHaveBeenCalledTimes(2)
      expect(logger).toHaveBeenCalledWith(
        '[WebhookDlqProcessor] Starting replay loop every 1000ms',
      )

      processor.stop()
    })

    it('ignores a duplicate start', () => {
      const processor = build(makeDlqStore([]), makeWebhookStore([]), { intervalMs: 1000 })

      processor.start()
      processor.start()

      expect(logger).toHaveBeenCalledWith('[WebhookDlqProcessor] Already running')
      processor.stop()
    })

    it('stops cleanly and logs only when running', () => {
      const processor = build(makeDlqStore([]), makeWebhookStore([]), { intervalMs: 1000 })

      processor.stop()
      expect(logger).not.toHaveBeenCalledWith('[WebhookDlqProcessor] Stopped')

      processor.start()
      processor.stop()
      expect(logger).toHaveBeenCalledWith('[WebhookDlqProcessor] Stopped')
    })

    it('survives a failing initial run without crashing the loop', async () => {
      const dlq = makeDlqStore([])
      dlq.list.mockRejectedValueOnce(new Error('db down'))
      const processor = build(dlq, makeWebhookStore([]), { intervalMs: 1000 })

      processor.start()
      await Promise.resolve()
      await Promise.resolve()

      expect(logger).toHaveBeenCalledWith(expect.stringContaining('Error in initial run: db down'))
      expect(processor.isRunning()).toBe(false)
      processor.stop()
    })
  })

  // ── Single-entry replay ────────────────────────────────────────────────────

  describe('replayEntry', () => {
    it('replays one entry by id regardless of the batch grace period', async () => {
      const dlq = makeDlqStore([makeEntry({ failedAt: new Date(NOW).toISOString() })])
      const webhooks = makeWebhookStore([makeWebhook()])
      const processor = build(dlq, webhooks, { minAgeMs: 60_000 })

      const outcome = await processor.replayEntry('dlq_1')

      expect(outcome).toEqual({ entryId: 'dlq_1', outcome: { status: 'replayed' } })
      expect(dlq.markReplayed).toHaveBeenCalledTimes(1)
    })

    it('reports an unknown id as invalid rather than throwing', async () => {
      const processor = build(makeDlqStore([]), makeWebhookStore([]))

      const outcome = await processor.replayEntry('dlq_missing')

      expect(outcome).toEqual({
        entryId: 'dlq_missing',
        outcome: { status: 'invalid', reason: 'not_found' },
      })
    })

    it('refuses a malformed entry and leaves it unmarked', async () => {
      const dlq = makeDlqStore([makeEntry({ id: 'dlq_bad', payload: undefined as never })])
      const webhooks = makeWebhookStore([makeWebhook()])
      const processor = build(dlq, webhooks)

      const outcome = await processor.replayEntry('dlq_bad')

      expect(outcome.outcome).toEqual({ status: 'invalid', reason: 'missing_payload' })
      expect(deliverWebhookMock).not.toHaveBeenCalled()
      expect(dlq.markReplayed).not.toHaveBeenCalled()
    })

    it('reports a missing webhook as orphaned', async () => {
      const dlq = makeDlqStore([makeEntry({ webhookId: 'wh_gone' })])
      const processor = build(dlq, makeWebhookStore([]))

      const outcome = await processor.replayEntry('dlq_1')

      expect(outcome.outcome).toEqual({ status: 'orphaned' })
      expect(deliverWebhookMock).not.toHaveBeenCalled()
    })

    it('refuses to replay to an inactive webhook', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook({ active: false })])
      const processor = build(dlq, webhooks)

      const outcome = await processor.replayEntry('dlq_1')

      expect(outcome.outcome).toEqual({ status: 'skipped', reason: 'inactive_webhook' })
      expect(deliverWebhookMock).not.toHaveBeenCalled()
    })

    it('honours dry-run mode', async () => {
      const dlq = makeDlqStore([makeEntry()])
      const webhooks = makeWebhookStore([makeWebhook()])
      const processor = build(dlq, webhooks, { dryRun: true })

      const outcome = await processor.replayEntry('dlq_1')

      expect(outcome.outcome).toEqual({ status: 'skipped', reason: 'dry_run' })
      expect(dlq.markReplayed).not.toHaveBeenCalled()
    })
  })

  // ── Skip-reason surface ────────────────────────────────────────────────────

  describe('skip reasons', () => {
    it('never delivers an already-replayed entry', async () => {
      const dlq = makeDlqStore([makeEntry({ replayedAt: new Date(NOW - 10).toISOString() })])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks).run()

      expect(result.skippedCount).toBe(1)
      expect(deliverWebhookMock).not.toHaveBeenCalled()
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('already_replayed'))
    })

    it('treats an empty-string replayedAt as not yet replayed', async () => {
      const dlq = makeDlqStore([makeEntry({ replayedAt: '' as unknown as string })])
      const webhooks = makeWebhookStore([makeWebhook()])

      const result = await build(dlq, webhooks).run()

      expect(result.replayedCount).toBe(1)
    })

    it('emits a distinct log line for every skip reason the type declares', async () => {
      const cases: Array<[DlqSkipReason, DlqEntry[], Partial<WebhookConfig>[]]> = [
        ['already_replayed', [makeEntry({ replayedAt: '2026-02-01T00:00:00.000Z' })], []],
        ['too_recent', [makeEntry({ failedAt: new Date(NOW).toISOString() })], []],
        ['attempts_exhausted', [makeEntry({ attempts: 50 })], []],
        ['inactive_webhook', [makeEntry({ webhookId: 'wh_inactive' })], [makeWebhook({ id: 'wh_inactive', active: false })]],
        ['dry_run', [makeEntry()], [makeWebhook()]],
      ]

      for (const [reason, entries, configs] of cases) {
        const dlq = makeDlqStore(entries)
        const webhooks = makeWebhookStore(configs)
        await new WebhookDlqProcessor(dlq.store, webhooks.store, {
          logger,
          now: () => NOW,
          dryRun: reason === 'dry_run',
        }).run()
      }

      const reasons: DlqSkipReason[] = [
        'already_replayed',
        'too_recent',
        'attempts_exhausted',
        'inactive_webhook',
        'dry_run',
      ]
      for (const reason of reasons) {
        expect(
          logger.mock.calls.some(args => args[0].includes(reason)),
          `expected a log line for ${reason}`,
        ).toBe(true)
      }
    })
  })
})

// ── Standalone helper ─────────────────────────────────────────────────────────

describe('processWebhookDlq', () => {
  beforeEach(() => {
    deliverWebhookMock.mockReset()
    deliverWebhookMock.mockImplementation(async (webhook: WebhookConfig) => successDelivery(webhook.id))
  })

  it('runs a single replay cycle', async () => {
    const dlq = makeDlqStore([makeEntry()])
    const webhooks = makeWebhookStore([makeWebhook()])

    const result = await processWebhookDlq(dlq.store, webhooks.store, { now: () => NOW })

    expect(result.replayedCount).toBe(1)
    expect(dlq.markReplayed).toHaveBeenCalledTimes(1)
  })

  it('defaults every option when none are supplied', async () => {
    const dlq = makeDlqStore([makeEntry()])
    const webhooks = makeWebhookStore([makeWebhook()])

    const result = await processWebhookDlq(dlq.store, webhooks.store)

    expect(result.replayedCount).toBe(1)
  })
})
