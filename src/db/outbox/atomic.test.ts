import { describe, expect, it, vi } from 'vitest'
import type { CreateOutboxEvent } from './types.js'
import { AtomicOutboxCoordinator, assertOutboxTransactionClient } from './atomic.js'

const event = (suffix = '1'): CreateOutboxEvent => ({ aggregateType: 'identity', aggregateId: `identity-${suffix}`, eventType: 'identity.updated', payload: { suffix } })

function harness() {
  const client = { query: vi.fn() } as any
  const transactions = { withTransaction: vi.fn(async (callback: (value: any) => Promise<unknown>) => callback(client)) }
  const emitter = { emitBatch: vi.fn(async (_db: unknown, records: CreateOutboxEvent[]) => records.map((_, index) => BigInt(index + 1))) }
  return { client, transactions, emitter, coordinator: new AtomicOutboxCoordinator(transactions, emitter) }
}

describe('AtomicOutboxCoordinator', () => {
  it('runs state mutation and event insertion on the same transaction client', async () => {
    const { client, transactions, emitter, coordinator } = harness()
    const result = await coordinator.runOne(async db => { expect(db).toBe(client); return { id: 'bond-1' } }, value => ({ ...event(), aggregateId: value.id }))
    expect(result).toEqual({ value: { id: 'bond-1' }, eventIds: [1n] })
    expect(transactions.withTransaction).toHaveBeenCalledTimes(1)
    expect(emitter.emitBatch).toHaveBeenCalledWith(client, [{ ...event(), aggregateId: 'bond-1' }])
  })

  it('does not emit when the business mutation fails before the event factory', async () => {
    const { transactions, emitter, coordinator } = harness()
    await expect(coordinator.runOne(async () => { throw new Error('state failed') }, event)).rejects.toThrow('state failed')
    expect(emitter.emitBatch).not.toHaveBeenCalled()
    expect(transactions.withTransaction).toHaveBeenCalledTimes(1)
  })

  it('propagates an outbox insert failure so the transaction rolls back', async () => {
    const { emitter, coordinator } = harness()
    emitter.emitBatch.mockRejectedValueOnce(new Error('insert failed'))
    await expect(coordinator.runOne(async () => 'changed', event)).rejects.toThrow('insert failed')
  })

  it('rejects silent mutations by default and allows an explicit exception', async () => {
    const { emitter, coordinator } = harness()
    await expect(coordinator.run(async () => 1, () => [])).rejects.toThrow('at least one event')
    expect(emitter.emitBatch).not.toHaveBeenCalled()
    await expect(coordinator.run(async () => 1, () => [], { allowEmptyEvents: true })).resolves.toEqual({ value: 1, eventIds: [] })
  })

  it('emits a batch only after all state work succeeds', async () => {
    const { emitter, coordinator } = harness()
    const order: string[] = []
    const result = await coordinator.run(async () => { order.push('mutation'); return 4 }, () => { order.push('events'); return [event('a'), event('b')] })
    expect(order).toEqual(['mutation', 'events'])
    expect(emitter.emitBatch).toHaveBeenCalledWith(expect.anything(), [event('a'), event('b')])
    expect(result.eventIds).toEqual([1n, 2n])
  })

  it.each([
    ['missing aggregate type', { ...event(), aggregateType: '' }],
    ['missing aggregate id', { ...event(), aggregateId: '' }],
    ['missing event type', { ...event(), eventType: '' }],
    ['array payload', { ...event(), payload: [] as any }],
    ['missing payload', { ...event(), payload: undefined as any }],
  ])('validates %s before inserting', async (_name, invalid) => {
    const { emitter, coordinator } = harness()
    await expect(coordinator.run(async () => true, () => [invalid])).rejects.toThrow()
    expect(emitter.emitBatch).not.toHaveBeenCalled()
  })

  it('uses the operation label in transaction options', async () => {
    const { transactions, coordinator } = harness()
    await coordinator.runOne(async () => true, event, { operation: 'bond_create', maxRetries: 2 })
    expect(transactions.withTransaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ op: 'bond_create', maxRetries: 2 }))
  })

  it('lets event factories observe the mutation result', async () => {
    const { emitter, coordinator } = harness()
    await coordinator.runOne(async () => ({ id: 'result-7', owner: 'tenant-7' }), value => ({ ...event('result'), aggregateId: value.id, payload: { owner: value.owner } }))
    expect(emitter.emitBatch.mock.calls[0][1][0].payload).toEqual({ owner: 'tenant-7' })
  })

  it('fails closed when the emitter returns an incomplete id list', async () => {
    const { emitter, coordinator } = harness()
    emitter.emitBatch.mockResolvedValueOnce([])
    await expect(coordinator.runOne(async () => true, event)).rejects.toThrow('incomplete')
  })
})

describe('transaction-client guard', () => {
  it('accepts the shared client and rejects a second client', () => {
    const client = {} as any
    expect(() => assertOutboxTransactionClient(client, client)).not.toThrow()
    expect(() => assertOutboxTransactionClient({}, {})).toThrow('share')
  })
})
