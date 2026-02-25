import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseSlashEvent,
  HorizonSlashListener,
  createHorizonSlashListener,
  type SlashEventSource,
  type SlashEvent,
} from './horizonSlashEvents.js'
import type { SlashEventStore, ScoreTrigger } from './slashTypes.js'

describe('parseSlashEvent', () => {
  it('parses event with identity, amount, reason', () => {
    const raw = {
      identity: '0xabc',
      amount: '100',
      reason: 'fraud',
    }
    expect(parseSlashEvent(raw)).toEqual({
      identity: '0xabc',
      amount: '100',
      reason: 'fraud',
    })
  })

  it('parses event with bigint amount', () => {
    const raw = {
      identity: '0xdef',
      amount: BigInt(200),
      reason: 'negligence',
    }
    expect(parseSlashEvent(raw)).toEqual({
      identity: '0xdef',
      amount: '200',
      reason: 'negligence',
    })
  })

  it('parses event with alternative field names (identityAddress, slashedAmount)', () => {
    const raw = {
      identityAddress: '0xaddr',
      slashedAmount: '50',
      reason: 'breach',
    }
    expect(parseSlashEvent(raw)).toEqual({
      identity: '0xaddr',
      amount: '50',
      reason: 'breach',
    })
  })

  it('parses event with evidenceRef and timestamp', () => {
    const raw = {
      identity: '0xev',
      amount: '10',
      reason: 'proof',
      evidenceRef: 'ipfs://Qm...',
      timestamp: 12345,
    }
    expect(parseSlashEvent(raw)).toEqual({
      identity: '0xev',
      amount: '10',
      reason: 'proof',
      evidenceRef: 'ipfs://Qm...',
      timestamp: 12345,
    })
  })

  it('returns null when identity is missing', () => {
    expect(parseSlashEvent({ amount: '1', reason: 'x' })).toBeNull()
    expect(parseSlashEvent({ identity: '', amount: '1', reason: 'x' })).toBeNull()
  })

  it('returns null when amount is missing or invalid', () => {
    expect(parseSlashEvent({ identity: '0xa', reason: 'x' })).toBeNull()
    expect(parseSlashEvent({ identity: '0xa', amount: {}, reason: 'x' })).toBeNull()
  })

  it('defaults reason to empty string when missing', () => {
    const raw = { identity: '0xa', amount: '1' }
    expect(parseSlashEvent(raw)?.reason).toBe('')
  })
})

describe('HorizonSlashListener', () => {
  let store: SlashEventStore
  let inserted: SlashEvent[]
  let slashedAmounts: { identity: string; amount: string }[]

  beforeEach(() => {
    inserted = []
    slashedAmounts = []
    store = {
      insertSlashEvent: vi.fn(async (e: SlashEvent) => {
        inserted.push(e)
      }),
      addSlashedAmountToBond: vi.fn(async (identity: string, amount: string) => {
        slashedAmounts.push({ identity, amount })
      }),
    }
  })

  describe('DB update', () => {
    it('inserts into slash_events and updates bond slashed_amount on event', async () => {
      let handler: ((e: SlashEvent) => void | Promise<void>) | null = null
      const source: SlashEventSource = {
        subscribe: (h) => {
          handler = h
          return () => {}
        },
      }
      const listener = new HorizonSlashListener(source, store)
      listener.start()
      expect(handler).not.toBeNull()
      const ev: SlashEvent = {
        identity: '0xuser',
        amount: '500',
        reason: 'fraud',
        evidenceRef: 'Qmxxx',
      }
      await handler!(ev)
      expect(inserted[0]).toEqual({
        identity: '0xuser',
        amount: '500',
        reason: 'fraud',
        evidenceRef: 'Qmxxx',
      })
      expect(slashedAmounts).toEqual([{ identity: '0xuser', amount: '500' }])
      listener.stop()
    })

    it('handleEvent performs insert and addSlashedAmountToBond', async () => {
      const source: SlashEventSource = { subscribe: () => {} }
      const listener = new HorizonSlashListener(source, store)
      await listener.handleEvent({
        identity: '0xid',
        amount: '100',
        reason: 'reason',
      })
      expect(inserted).toHaveLength(1)
      expect(inserted[0].identity).toBe('0xid')
      expect(inserted[0].amount).toBe('100')
      expect(slashedAmounts).toEqual([{ identity: '0xid', amount: '100' }])
    })

    it('handleRawEvent parses and processes valid raw event', async () => {
      const source: SlashEventSource = { subscribe: () => {} }
      const listener = new HorizonSlashListener(source, store)
      const ok = await listener.handleRawEvent({
        identity: '0xraw',
        amount: '99',
        reason: 'raw',
      })
      expect(ok).toBe(true)
      expect(inserted).toHaveLength(1)
      expect(inserted[0].identity).toBe('0xraw')
      expect(slashedAmounts).toHaveLength(1)
    })

    it('handleRawEvent returns false and does not update DB for invalid raw event', async () => {
      const source: SlashEventSource = { subscribe: () => {} }
      const listener = new HorizonSlashListener(source, store)
      const ok = await listener.handleRawEvent({ amount: '1', reason: 'x' })
      expect(ok).toBe(false)
      expect(inserted).toHaveLength(0)
      expect(slashedAmounts).toHaveLength(0)
    })
  })

  describe('score trigger', () => {
    it('triggers score recalculation when scoreTrigger is provided', async () => {
      const triggered: string[] = []
      const scoreTrigger: ScoreTrigger = {
        trigger: vi.fn(async (identity: string) => {
          triggered.push(identity)
        }),
      }
      const source: SlashEventSource = { subscribe: () => {} }
      const listener = new HorizonSlashListener(source, store, scoreTrigger)
      await listener.handleEvent({
        identity: '0xscored',
        amount: '50',
        reason: 'r',
      })
      expect(triggered).toEqual(['0xscored'])
      expect(scoreTrigger.trigger).toHaveBeenCalledWith('0xscored')
    })

    it('does not call score trigger when not provided', async () => {
      const source: SlashEventSource = { subscribe: () => {} }
      const listener = new HorizonSlashListener(source, store)
      await listener.handleEvent({
        identity: '0xno',
        amount: '1',
        reason: 'r',
      })
      expect(inserted).toHaveLength(1)
      expect(slashedAmounts).toHaveLength(1)
    })
  })

  describe('subscribe and poll', () => {
    it('start() subscribes and processes events from source', async () => {
      let handler: ((e: SlashEvent) => void) | null = null
      const source: SlashEventSource = {
        subscribe: (h) => {
          handler = h
          return () => {}
        },
      }
      const listener = new HorizonSlashListener(source, store)
      listener.start()
      expect(handler).not.toBeNull()
      handler!({
        identity: '0xsub',
        amount: '111',
        reason: 'sub',
      })
      await vi.waitFor(() => inserted.length >= 1)
      expect(inserted[0].identity).toBe('0xsub')
      listener.stop()
    })

    it('pollOnce() processes all events from source.poll()', async () => {
      const source: SlashEventSource = {
        subscribe: () => {},
        poll: async () => [
          { identity: '0xp1', amount: '1', reason: 'a' },
          { identity: '0xp2', amount: '2', reason: 'b' },
        ],
      }
      const listener = new HorizonSlashListener(source, store)
      const count = await listener.pollOnce()
      expect(count).toBe(2)
      expect(inserted).toHaveLength(2)
      expect(inserted.map((e) => e.identity)).toEqual(['0xp1', '0xp2'])
      expect(slashedAmounts).toHaveLength(2)
    })

    it('pollOnce() returns 0 when source has no poll', async () => {
      const source: SlashEventSource = { subscribe: () => {} }
      const listener = new HorizonSlashListener(source, store)
      const count = await listener.pollOnce()
      expect(count).toBe(0)
      expect(inserted).toHaveLength(0)
    })
  })

  describe('start/stop', () => {
    it('stop() calls unsubscribe from source', () => {
      const unsub = vi.fn()
      const source: SlashEventSource = {
        subscribe: () => unsub,
      }
      const listener = new HorizonSlashListener(source, store)
      listener.start()
      listener.stop()
      expect(unsub).toHaveBeenCalled()
    })

    it('start() is idempotent (does not double-subscribe)', () => {
      let subscribeCalls = 0
      const source: SlashEventSource = {
        subscribe: () => {
          subscribeCalls += 1
          return () => {}
        },
      }
      const listener = new HorizonSlashListener(source, store)
      listener.start()
      listener.start()
      expect(subscribeCalls).toBe(1)
      listener.stop()
    })
  })
})

describe('createHorizonSlashListener', () => {
  it('returns HorizonSlashListener instance', () => {
    const source: SlashEventSource = { subscribe: () => {} }
    const store: SlashEventStore = {
      insertSlashEvent: async () => {},
      addSlashedAmountToBond: async () => {},
    }
    const listener = createHorizonSlashListener(source, store)
    expect(listener).toBeInstanceOf(HorizonSlashListener)
    expect(listener.handleEvent).toBeDefined()
    expect(listener.handleRawEvent).toBeDefined()
    expect(listener.pollOnce).toBeDefined()
  })
})
