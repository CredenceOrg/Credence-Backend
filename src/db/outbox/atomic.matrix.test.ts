import { describe, expect, it, vi } from 'vitest'
import type { CreateOutboxEvent } from './types.js'
import { AtomicOutboxCoordinator } from './atomic.js'

const makeEvent = (n: number): CreateOutboxEvent => ({
  aggregateType: 'wallet',
  aggregateId: `wallet-${n}`,
  eventType: 'wallet.balance_changed',
  payload: { n, amount: n * 10 },
})

type FakeClient = { query: ReturnType<typeof vi.fn>; writes: string[] }

function makeHarness() {
  const client: FakeClient = { query: vi.fn(), writes: [] }
  const commits: string[] = []
  const rollbacks: string[] = []
  const runner = {
    withTransaction: vi.fn(async (callback: (client: FakeClient) => Promise<unknown>) => {
      try {
        const result = await callback(client as any)
        commits.push('commit')
        return result
      } catch (error) {
        rollbacks.push('rollback')
        throw error
      }
    }),
  }
  const emitter = {
    emitBatch: vi.fn(async (db: FakeClient, events: CreateOutboxEvent[]) => {
      expect(db).toBe(client)
      client.writes.push(...events.map(item => `outbox:${item.aggregateId}`))
      return events.map((_, index) => BigInt(index + 100))
    }),
  }
  return { client, commits, rollbacks, runner, emitter, coordinator: new AtomicOutboxCoordinator(runner as any, emitter as any) }
}

describe('atomic mutation crash-point matrix', () => {
  it.each([
    ['before state write', async () => { throw new Error('before-write') }],
    ['during state write', async (db: FakeClient) => { db.writes.push('state'); throw new Error('state-write') }],
    ['after state write', async (db: FakeClient) => { db.writes.push('state'); throw new Error('after-state') }],
  ])('rolls back at %s without an outbox row', async (_point, mutation) => {
    const { emitter, commits, rollbacks, client, coordinator } = makeHarness()
    await expect(coordinator.run(mutation as any, () => [makeEvent(1)])).rejects.toThrow()
    expect(emitter.emitBatch).not.toHaveBeenCalled()
    expect(commits).toEqual([])
    expect(rollbacks).toEqual(['rollback'])
    expect(client.writes.filter(write => write.startsWith('outbox:'))).toEqual([])
  })

  it('rolls back a state write when outbox insertion fails', async () => {
    const { emitter, commits, rollbacks, client, coordinator } = makeHarness()
    emitter.emitBatch.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(coordinator.run(async db => { client.writes.push('state'); return db }, () => [makeEvent(2)])).rejects.toThrow('database unavailable')
    expect(client.writes).toEqual(['state', 'outbox:wallet-2'])
    expect(commits).toEqual([])
    expect(rollbacks).toEqual(['rollback'])
  })

  it('commits state and all related events together', async () => {
    const { emitter, commits, rollbacks, client, coordinator } = makeHarness()
    const result = await coordinator.run(async db => { db.writes.push('state'); return { count: 3 } }, value => [makeEvent(1), { ...makeEvent(2), payload: { count: value.count } }])
    expect(result.eventIds).toEqual([100n, 101n])
    expect(client.writes).toEqual(['state', 'outbox:wallet-1', 'outbox:wallet-2'])
    expect(commits).toEqual(['commit'])
    expect(rollbacks).toEqual([])
  })

  it('passes transaction options through without changing the client', async () => {
    const { runner, client, coordinator } = makeHarness()
    await coordinator.runOne(async db => { expect(db).toBe(client); return true }, makeEvent(3), { operation: 'wallet_debit', isolationLevel: 'SERIALIZABLE', retryOnLockTimeout: true })
    expect(runner.withTransaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ op: 'wallet_debit', isolationLevel: 'SERIALIZABLE', retryOnLockTimeout: true }))
  })

  it('does not publish while the transaction callback is still running', async () => {
    const { emitter, runner, coordinator } = makeHarness()
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const run = coordinator.run(async () => { await paused; return true }, () => [makeEvent(4)])
    await Promise.resolve()
    expect(emitter.emitBatch).not.toHaveBeenCalled()
    release()
    await run
    expect(emitter.emitBatch).toHaveBeenCalledTimes(1)
    expect(runner.withTransaction).toHaveBeenCalledTimes(1)
  })

  it('does not call the event factory after a failed mutation', async () => {
    const { coordinator } = makeHarness()
    const events = vi.fn(() => [makeEvent(5)])
    await expect(coordinator.run(async () => { throw new Error('no result') }, events)).rejects.toThrow('no result')
    expect(events).not.toHaveBeenCalled()
  })

  it('supports asynchronous event construction', async () => {
    const { emitter, coordinator } = makeHarness()
    await coordinator.run(async () => 'ok', async value => [{ ...makeEvent(6), payload: { value } }])
    expect(emitter.emitBatch.mock.calls[0][1][0].payload).toEqual({ value: 'ok' })
  })

  it('rejects whitespace-only identifiers', async () => {
    const { emitter, coordinator } = makeHarness()
    for (const field of ['aggregateType', 'aggregateId', 'eventType'] as const) {
      const invalid = { ...makeEvent(7), [field]: '   ' }
      await expect(coordinator.run(async () => true, () => [invalid])).rejects.toThrow(field)
    }
    expect(emitter.emitBatch).not.toHaveBeenCalled()
  })

  it('validates every event in a batch before calling the emitter', async () => {
    const { emitter, coordinator } = makeHarness()
    await expect(coordinator.run(async () => true, () => [makeEvent(8), { ...makeEvent(9), eventType: '' }])).rejects.toThrow('eventType')
    expect(emitter.emitBatch).not.toHaveBeenCalled()
  })

  it('does not accept a null event list', async () => {
    const { coordinator } = makeHarness()
    await expect(coordinator.run(async () => true, () => null as any)).rejects.toThrow()
  })

  it('does not accept primitive payloads', async () => {
    const { emitter, coordinator } = makeHarness()
    for (const payload of [null, 'text', 42, true] as any[]) {
      await expect(coordinator.run(async () => true, () => [{ ...makeEvent(10), payload }])).rejects.toThrow('payload')
    }
    expect(emitter.emitBatch).not.toHaveBeenCalled()
  })

  it('fails closed when the emitter acknowledges too many events', async () => {
    const { emitter, coordinator } = makeHarness()
    emitter.emitBatch.mockResolvedValueOnce([100n, 101n])
    await expect(coordinator.run(async () => true, () => [makeEvent(11)])).rejects.toThrow('incomplete')
  })

  it('keeps bigint ids intact for large database identifiers', async () => {
    const { emitter, coordinator } = makeHarness()
    const large = 9_007_199_254_740_993n
    emitter.emitBatch.mockResolvedValueOnce([large])
    const result = await coordinator.runOne(async () => true, makeEvent(12))
    expect(result.eventIds[0]).toBe(large)
  })

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))('preserves event order in batch %i', async count => {
    const { emitter, coordinator } = makeHarness()
    const events = Array.from({ length: count }, (_, index) => makeEvent(index))
    const result = await coordinator.run(async () => count, () => events)
    expect(emitter.emitBatch.mock.calls[emitter.emitBatch.mock.calls.length - 1]?.[1]).toEqual(events)
    expect(result.eventIds).toHaveLength(count)
  })

  it('allows a mutation with no events only when explicitly configured', async () => {
    const { commits, coordinator } = makeHarness()
    await expect(coordinator.run(async () => ({ acknowledged: true }), () => [], { allowEmptyEvents: true })).resolves.toEqual({ value: { acknowledged: true }, eventIds: [] })
    expect(commits).toEqual(['commit'])
  })

  it('does not silently swallow transaction errors', async () => {
    const { runner, coordinator } = makeHarness()
    const expected = new Error('serialization failure')
    runner.withTransaction.mockRejectedValueOnce(expected)
    await expect(coordinator.runOne(async () => true, makeEvent(13))).rejects.toBe(expected)
  })

  it('uses the default operation label when none is supplied', async () => {
    const { runner, coordinator } = makeHarness()
    await coordinator.runOne(async () => true, makeEvent(14))
    expect(runner.withTransaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ op: 'atomic_outbox_mutation' }))
  })
})
