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
    const store = makeStore({
      upsert: vi.fn().mockImplementation(async (input: any) => {
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
    const executor = makeExecutor( {
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

  describe('upfront payload validation (atomic semantics)', () => {
    it('throws error when an item has invalid amount (negative or bad precision) before applying any writes', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)

      const items = [
        { bondId: 'bond-1', amount: '100', transactionHash: 'tx-1' },
        { bondId: 'bond-2', amount: '-50', transactionHash: 'tx-2' },
      ]

      await expect(processor.process(items)).rejects.toThrow('invalid amount')
      expect(store.upsert).not.toHaveBeenCalled()
      expect(executor.execute).not.toHaveBeenCalled()
    })

    it('throws error when an item has empty or missing transactionHash before applying any writes', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)

      const items = [
        { bondId: 'bond-1', amount: '100', transactionHash: '' },
      ]

      await expect(processor.process(items)).rejects.toThrow('invalid transactionHash')
      expect(store.upsert).not.toHaveBeenCalled()
      expect(executor.execute).not.toHaveBeenCalled()
    })

    it('throws error when an item has empty bondId before applying any writes', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)

      const items = [
        { bondId: '', amount: '100', transactionHash: 'tx-1' },
      ]

      await expect(processor.process(items)).rejects.toThrow('invalid bondId')
      expect(store.upsert).not.toHaveBeenCalled()
      expect(executor.execute).not.toHaveBeenCalled()
    })

    it('throws error when payload is not an array', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      await expect(processor.process(null as any)).rejects.toThrow(
        'Batch payout payload must be an array of items',
      )
    })

    it('throws error when an item is null or not an object', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      await expect(processor.process([null as any])).rejects.toThrow(
        'must be a valid payout item object',
      )
    })

    it('throws error when amount has more than 18 decimal places', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [
        { bondId: 'bond-1', amount: '1.0000000000000000001', transactionHash: 'tx-1' },
      ]
      await expect(processor.process(items)).rejects.toThrow('invalid amount')
    })

    it('throws error when amount exceeds 1e18', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [
        { bondId: 'bond-1', amount: '1000000000000000000000', transactionHash: 'tx-1' },
      ]
      await expect(processor.process(items)).rejects.toThrow('invalid amount')
    })

    it('throws error when transactionHash exceeds 128 characters', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [
        { bondId: 'bond-1', amount: '100', transactionHash: 'x'.repeat(129) },
      ]
      await expect(processor.process(items)).rejects.toThrow('invalid transactionHash')
    })

    it('throws error when settledAt is an invalid Date', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [
        { bondId: 'bond-1', amount: '100', transactionHash: 'tx-1', settledAt: new Date(NaN) },
      ]
      await expect(processor.process(items)).rejects.toThrow('invalid settledAt')
    })

    it('throws error when the batch exceeds the configured maximum size', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor(), {
        maxBatchSize: 2,
      })
      const items = makeItems(3)
      await expect(processor.process(items)).rejects.toThrow('exceeds the maximum')
    })

    it('throws error when the batch contains duplicate transactionHashes', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)
      const items = [
        { bondId: 'bond-1', amount: '100', transactionHash: 'tx-1' },
        { bondId: 'bond-2', amount: '200', transactionHash: 'tx-1' },
      ]
      await expect(processor.process(items)).rejects.toThrow('duplicate transactionHash')
      expect(store.upsert).not.toHaveBeenCalled()
      expect(executor.execute).not.toHaveBeenCalled()
    })

    it('accepts a batch at the exact maximum size boundary', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor(), {
        maxBatchSize: 2,
      })
      const result = await processor.process(makeItems(2))
      expect(result.total).toBe(2)
      expect(result.settled).toBe(2)
    })

    it('accepts an amount at the exact upper bound of 1e18', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [
        { bondId: 'bond-1', amount: '1000000000000000000', transactionHash: 'tx-1' },
      ]
      const result = await processor.process(items)
      expect(result.settled).toBe(1)
    })

    it('accepts a zero amount as a boundary case', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [
        { bondId: 'bond-1', amount: '0', transactionHash: 'tx-1' },
      ]
      const result = await processor.process(items)
      expect(result.settled).toBe(1)
    })
  })

  describe('recovery and concurrency behavior', () => {
    it('returns the failed item for retry and settles it on the second attempt', async () => {
      const store = makeStore()
      let attempt = 0
      const executor = makeExecutor({
        execute: vi.fn().mockImplementation(async () => {
          attempt++
          if (attempt === 1) throw new Error('transient network error')
        }),
      })
      const processor = new BatchPayoutProcessor(store, executor)

      const items = makeItems(1)
      const first = await processor.process(items)
      expect(first.failed).toBe(1)

      const retryable = getRetryableItems(items, first)
      expect(retryable).toHaveLength(1)

      const second = await processor.process(retryable)
      expect(second.settled).toBe(1)
      expect(second.failed).toBe(0)
    })

    it('preserves per-item isolation when a store failure and an execution failure occur in the same batch', async () => {
      const store = makeStore({
        upsert: vi.fn().mockImplementation(async (input: any) => {
          if (input.transactionHash === 'tx-0') {
            throw new Error('db down')
          }
          return { isDuplicate: false }
        }),
      })
      const executor = makeExecutor({
        execute: vi.fn().mockImplementation(async (item: PayoutItem) => {
          if (item.transactionHash === 'tx-1') {
            throw new Error('execution failed')
          }
        }),
      })
      const processor = new BatchPayoutProcessor(store, executor)

      const result = await processor.process(makeItems(3))
      expect(result.total).toBe(3)
      expect(result.failed).toBe(2)
      expect(result.settled).toBe(1)
      expect(result.items.filter((r) => r.retryEligible)).toHaveLength(2)
    })

    it('processes concurrent batches independently without cross-contamination', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)

      const [a, b] = await Promise.all(
        [processor.process(makeItems(2)), processor.process(makeItems(3))],
      )
      expect(a.total).toBe(2)
      expect(b.total).toBe(3)
      expect(a.settled).toBe(2)
      expect(b.settled).toBe(3)
    })

    it('emits diagnostic logs without exposing amounts', async () => {
      const logs: string[] = []
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor(), {
        logger: (m) => logs.push(m),
      })
      await processor.process(makeItems(1))
      expect(logs.some((m) => m.includes('Batch complete'))).toBe(true)
      expect(logs.join('\n')).not.toContain('100')
    })
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

  it('returns an empty array for an empty original batch', () => {
    const result = {
      total: 0,
      settled: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      startTime: new Date().toISOString(),
      items: [],
    }
    expect(getRetryableItems([], result)).toEqual([])
  })
})


describe('claimForPayout and transitionStatus semantics', () => {
  it('resubmitting a settled item counts it in skipped with retryEligible: false and executor is not called', async () => {
    const store = makeStore({
      claimForPayout: vi.fn().mockResolvedValue({ claimed: false, currentStatus: 'settled' }),
    })
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(1)
    const result = await processor.process(items)

    expect(result.settled).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.items[0].status).toBe('skipped')
    expect(result.items[0].retryEligible).toBe(false)
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('two concurrent process calls on same item give exactly one executor call', async () => {
    let callCount = 0
    const store = makeStore({
      claimForPayout: vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return { claimed: true, currentStatus: 'pending' }
        }
        return { claimed: false, currentStatus: 'pending', isOrphaned: false }
      }),
      transitionStatus: vi.fn().mockResolvedValue(true),
    })
    const executor = makeExecutor()
    const processor1 = new BatchPayoutProcessor(store, executor)
    const processor2 = new BatchPayoutProcessor(store, executor)

    const item = makeItems(1)
    const [res1, res2] = await Promise.all([
      processor1.process(item),
      processor2.process(item),
    ])

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(res1.settled + res2.settled).toBe(1)
    expect(res1.skipped + res2.skipped).toBe(1)
  })

  it('pending row older than orphan threshold is reported as skipped with reason orphaned', async () => {
    const store = makeStore({
      claimForPayout: vi.fn().mockResolvedValue({
        claimed: false,
        currentStatus: 'pending',
        isOrphaned: true,
      }),
    })
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor, { orphanThresholdMs: 60000 })

    const items = makeItems(1)
    const result = await processor.process(items)

    expect(result.skipped).toBe(1)
    expect(result.items[0].status).toBe('skipped')
    expect(result.items[0].error).toBe('orphaned')
    expect(result.items[0].retryEligible).toBe(false)
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('in_flight pending row is reported as skipped with reason in_progress', async () => {
    const store = makeStore({
      claimForPayout: vi.fn().mockResolvedValue({
        claimed: false,
        currentStatus: 'pending',
        isOrphaned: false,
      }),
    })
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(1)
    const result = await processor.process(items)

    expect(result.skipped).toBe(1)
    expect(result.items[0].status).toBe('skipped')
    expect(result.items[0].error).toBe('in_progress')
    expect(result.items[0].retryEligible).toBe(false)
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('retries failed item cleanly on second attempt with claim and transitions', async () => {
    let attempt = 0
    let currentStatus = 'failed'
    const store = makeStore({
      claimForPayout: vi.fn().mockImplementation(async () => {
        attempt++
        currentStatus = 'pending'
        return { claimed: true, currentStatus: 'pending' }
      }),
      transitionStatus: vi.fn().mockImplementation(async (_hash, from, to) => {
        currentStatus = to
        return true
      }),
    })
    const executor = makeExecutor({
      execute: vi.fn().mockImplementation(async () => {
        if (attempt === 1) throw new Error('network drop')
      }),
    })
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(1)
    const run1 = await processor.process(items)
    expect(run1.failed).toBe(1)
    expect(currentStatus).toBe('failed')

    const retryable = getRetryableItems(items, run1)
    expect(retryable).toHaveLength(1)

    const run2 = await processor.process(retryable)
    expect(run2.settled).toBe(1)
    expect(currentStatus).toBe('settled')
  })
})
