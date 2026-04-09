import { describe, it, expect, vi } from 'vitest'
import {
  BatchPayoutProcessor,
  getRetryableItems,
  type PayoutItem,
  type PayoutExecutor,
  type PayoutSettlementStore,
} from './batchPayoutProcessor.js'

function makeStore(overrides: Partial<PayoutSettlementStore> = {}): PayoutSettlementStore {
  return {
    upsert: vi.fn().mockResolvedValue({ isDuplicate: false }),
    ...overrides,
  }
}

function makeExecutor(overrides: Partial<PayoutExecutor> = {}): PayoutExecutor {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeItems(count: number): PayoutItem[] {
  return Array.from({ length: count }, (_, i) => ({
    bondId: `bond-${i}`,
    amount: `${(i + 1) * 100}`,
    transactionHash: `tx-${i}`,
  }))
}

describe('BatchPayoutProcessor', () => {
  it('settles all items when no errors occur', async () => {
    const store = makeStore()
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(3)
    const result = await processor.process(items)

    expect(result.total).toBe(3)
    expect(result.settled).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.items.every((r) => r.status === 'settled')).toBe(true)
    expect(result.items.every((r) => r.retryEligible === false)).toBe(true)
  })

  it('isolates a single failure from other items', async () => {
    const executor = makeExecutor({
      execute: vi.fn().mockImplementation(async (item: PayoutItem) => {
        if (item.transactionHash === 'tx-1') {
          throw new Error('insufficient funds')
        }
      }),
    })
    const store = makeStore()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(3)
    const result = await processor.process(items)

    expect(result.settled).toBe(2)
    expect(result.failed).toBe(1)

    const failedItem = result.items.find((r) => r.transactionHash === 'tx-1')!
    expect(failedItem.status).toBe('failed')
    expect(failedItem.retryEligible).toBe(true)
    expect(failedItem.error).toBe('insufficient funds')

    const successItems = result.items.filter((r) => r.transactionHash !== 'tx-1')
    expect(successItems.every((r) => r.status === 'settled')).toBe(true)
  })

  it('skips duplicate items without marking them as failed', async () => {
    const store = makeStore({
      upsert: vi.fn().mockResolvedValue({ isDuplicate: true }),
    })
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(2)
    const result = await processor.process(items)

    expect(result.settled).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(2)
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('marks item as failed and retry-eligible when initial upsert fails', async () => {
    let callCount = 0
    const store = makeStore({
      upsert: vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) throw new Error('db connection lost')
        return { isDuplicate: false }
      }),
    })
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(2)
    const result = await processor.process(items)

    expect(result.failed).toBe(1)
    expect(result.settled).toBe(1)

    const failedItem = result.items.find((r) => r.transactionHash === 'tx-0')!
    expect(failedItem.retryEligible).toBe(true)
  })

  it('marks item as failed when execution succeeds but final status update fails', async () => {
    let upsertCalls = 0
    const store = makeStore({
      upsert: vi.fn().mockImplementation(async (input: any) => {
        upsertCalls++
        // First call (pending) succeeds, second call (settled) fails
        if (input.status === 'settled') {
          throw new Error('status update failed')
        }
        return { isDuplicate: false }
      }),
    })
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(1)
    const result = await processor.process(items)

    expect(result.failed).toBe(1)
    const item = result.items[0]
    expect(item.retryEligible).toBe(true)
    expect(item.error).toContain('status update failed')
  })

  it('persists failure status in store when execution fails', async () => {
    const upsertFn = vi.fn().mockResolvedValue({ isDuplicate: false })
    const store = makeStore({ upsert: upsertFn })
    const executor = makeExecutor({
      execute: vi.fn().mockRejectedValue(new Error('timeout')),
    })
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(1)
    await processor.process(items)

    // Should have been called twice: once for 'pending', once for 'failed'
    expect(upsertFn).toHaveBeenCalledTimes(2)
    const secondCall = upsertFn.mock.calls[1][0]
    expect(secondCall.status).toBe('failed')
  })

  it('handles empty batch gracefully', async () => {
    const store = makeStore()
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const result = await processor.process([])

    expect(result.total).toBe(0)
    expect(result.settled).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.items).toEqual([])
  })

  it('records accurate aggregate counts with mixed results', async () => {
    let upsertCallIndex = 0
    const store = makeStore({
      upsert: vi.fn().mockImplementation(async () => {
        upsertCallIndex++
        // Make the 3rd upsert call (item index 1, pending) return duplicate
        if (upsertCallIndex === 3) return { isDuplicate: true }
        return { isDuplicate: false }
      }),
    })
    const executor = makeExecutor({
      execute: vi.fn().mockImplementation(async (item: PayoutItem) => {
        if (item.transactionHash === 'tx-2') {
          throw new Error('network error')
        }
      }),
    })
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(4) // tx-0: success, tx-1: skipped, tx-2: failed, tx-3: success
    const result = await processor.process(items)

    expect(result.total).toBe(4)
    expect(result.settled).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.skipped).toBe(1)
  })
})

describe('getRetryableItems', () => {
  it('returns only items that are retry-eligible', () => {
    const items = makeItems(3)
    const result = {
      total: 3,
      settled: 1,
      failed: 2,
      skipped: 0,
      duration: 100,
      startTime: new Date().toISOString(),
      items: [
        { bondId: 'bond-0', transactionHash: 'tx-0', status: 'settled' as const, retryEligible: false },
        { bondId: 'bond-1', transactionHash: 'tx-1', status: 'failed' as const, retryEligible: true, error: 'err' },
        { bondId: 'bond-2', transactionHash: 'tx-2', status: 'failed' as const, retryEligible: true, error: 'err' },
      ],
    }

    const retryable = getRetryableItems(items, result)
    expect(retryable).toHaveLength(2)
    expect(retryable.map((i) => i.transactionHash)).toEqual(['tx-1', 'tx-2'])
  })

  it('returns empty array when nothing is retryable', () => {
    const items = makeItems(2)
    const result = {
      total: 2,
      settled: 2,
      failed: 0,
      skipped: 0,
      duration: 50,
      startTime: new Date().toISOString(),
      items: [
        { bondId: 'bond-0', transactionHash: 'tx-0', status: 'settled' as const, retryEligible: false },
        { bondId: 'bond-1', transactionHash: 'tx-1', status: 'settled' as const, retryEligible: false },
      ],
    }

    expect(getRetryableItems(items, result)).toEqual([])
  })
})
