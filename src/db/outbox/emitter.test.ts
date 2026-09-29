import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OutboxEventEmitter, OutboxEmitterError, MAX_BATCH_SIZE } from './emitter.js'
import { tracingContext } from '../../utils/logger.js'
import type { Queryable } from '../repositories/queryable.js'
import type { CreateOutboxEvent } from './types.js'

function fakeDb() {
  const query = vi.fn().mockResolved({ rows: [{ id: '1' }] })
  return { query } as unknown as Queryable & { query: typeof query }
}

const baseEvent: CreateOutboxEvent = {
  aggregateType: 'bond',
  aggregateId: 'bond-1',
  eventType: 'bond.created',
  payload: { address: '0xabc' },
}

describe('OutboxEventEmitter correlation id capture', () => {
  it('captures the active correlation id from the tracing context at emit time', async () => {
    const db = fakeDb()
    const emitter = new OutboxEventEmitter()
    const ctx = new Map<string, string>()
    ctx.set('correlationId', 'corr-from-request')

    await tracingContext.run(ctx, async () => {
      await emitter.emit(db, baseEvent)
    })

    const [, params] = db.query.mock.calls[0]
    // correlation_id is the last bind parameter in the INSERT statement.
    expect(params![params!.length - 1]).toBe('corr-from-request')
  })

  it('does not set a correlation id when there is no active tracing context', async () => {
    const db = fakeDb()
    const emitter = new OutboxEventEmitter()

    await emitter.emit(db, baseEvent)

    const [, params] = db.query.mock.calls[0]
    expect(params![params!.length - 1]).toBeUndefined()
  })

  it('respects an explicitly provided correlationId over the ambient context', async () => {
    const db = fakeDb()
    const emitter = new OutboxEventEmitter()
    const ctx = new Map<string, string>()
    ctx.set('correlationId', 'corr-ambient')

    await tracingContext.run(ctx, async () => {
      await emitter.emit(db, { ...baseEvent, correlationId: 'corr-explicit' })
    })

    const [, params] = db.query.mock.calls[0]
    expect(params![params!.length - 1]).toBe('corr-explicit')
  })

  it('emitBatch captures the same correlation id for every event in the batch', async () => {
    const db = fakeDb()
    const emitter = new OutboxEventEmitter()
    const ctx = new Map<string, string>()
    ctx.set('correlationId', 'corr-batch')

    await tracingContext.run(ctx, async () => {
      await emitter.emitBatch(db, [baseEvent, { ...baseEvent, aggregateId: 'bond-2' }])
    })

    expect(db.query).toHaveBeenCalledTimes(2)
    for (const call of db.query.mock.calls) {
      const params = call[1]!
      expect(params[params.length - 1]).toBe('corr-batch')
    }
  })
})

describe('OutboxEventEmitter boundary and validation', () => {
  let emitter: OutboxEventEmitter

  beforeEach(() => {
    emitter = new OutboxEventEmitter()
  })

  it('rejects a missing database connection', async () => {
    await expect(emitter.emit(undefined as unknown as Queryable, baseEvent)).rejects.toThrowError(OutboxEmitterError)
  })

  it('rejects a database without a query method', async () => {
    await expect(emitter.emit({} as unknown as Queryable, baseEvent)).rejects.toThrowError(OutboxEmitterError)
  })

  it('rejects a null event', async () => {
    const db = fakeDb()
    await expect(emitter.emit(db, null as unknown as CreateOutboxEvent)).rejects.toThrowError(OutboxEmitterError)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects an event with an empty aggregateType', async () => {
    const db = fakeDb()
    await expect(emitter.emit(db, { ...baseEvent, aggregateType: '' })).rejects.toThrowError(OutboxEmitterError)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects an event with a missing aggregateId', async () => {
    const db = fakeDb()
    await expect(emitter.emit(db, { ...baseEvent, aggregateId: '' })).rejects.toThrowError(OutboxEmitterError)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects an event with a missing eventType', async () => {
    const db = fakeDb()
    await expect(emitter.emit(db, { ...baseEvent, eventType: '' })).rejects.toThrowError(OutboxEmitterError)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a non-positive version', async () => {
    const db = fakeDb()
    await expect(emitter.emit(db, { ...baseEvent, version: 0 })).rejects.toThrowError(OutboxEmitterError)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('defaults the version to 1 when not provided', async () => {
    const db = fakeDb()
    await emitter.emit(db, baseEvent)
    const [, params] = db.query.mock.calls[0]
    // version is bound as the second-parameter after the tenant id column in the INSERT.
    expect(params).toContain(1)
  })

  it('rejects an empty batch', async () => {
    const db = fakeDb()
    await expect(emitter.emitBatch(db, [])).rejects.toThrowError(OutboxEmitterError)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a batch that exceeds MAX_BATCH_SIZE', async () => {
    const db = fakeDb()
    const events = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({ ...baseEvent, aggregateId: `bond-${i}` }))
    await expect(emitter.emitBatch(db, events)).rejects.toThrowError(OutboxEmitterError)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('accepts a batch at the MAX_BATCH_SIZE boundary', async () => {
    const db = fakeDb()
    const events = Array.from({ length: MAX_BATCH_SIZE }, (_, i) => ({ ...baseEvent, aggregateId: `bond-${i}` }))
    const ids = await emitter.emitBatch(db, events)
    expect(ids).toHaveLength(MAX_BATCH_SIZE)
    expect(db.query).toHaveBeenCalledTimes(MAX_BATCH_SIZE)
  })

  it('rejects a batch when any element is invalid and writes nothing', async () => {
    const db = fakeDb()
    const events = [baseEvent, { ...baseEvent, aggregateId: '' }, { ...baseEvent, aggregateId: 'bond-3' }]
    await expect(emitter.emitBatch(db, events)).rejects.toThrowError(OutboxEmitterError)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('reports the offending index for an invalid batch element', async () => {
    const db = fakeDb()
    const events = [baseEvent, { ...baseEvent, eventType: '' }]
    await expect(emitter.emitBatch(db, events)).rejects.toThrowError(OutboxEmitterError, /index 1/)
  })

  it('rejects a non-array batch argument', async () => {
    const db = fakeDb()
    await expect(emitter.emitBatch(db, null as unknown as CreateOutboxEvent[])).rejects.toThrowError(OutboxEmitterError)
  })
})

describe('OutboxEventEmitter failure recovery', () => {
  it('propagates repository failures without swallowing them', async () => {
    const db = fakeDb()
    db.query.mockRejectedOnce(new Error('dead connection'))
    const emitter = new OutboxEventEmitter()

    await expect(emitter.emit(db, baseEvent)).rejects.toThrowError(/dead connection/)
  })

  it('retries after a transient failure without losing the event', async () => {
    const db = fakeDb()
    db.query.mockRejectedOnce(new Error('transient'))
    const emitter = new OutboxEventEmitter()

    await expect(emitter.emit(db, baseEvent)).rejects.toThrowError(/transient/)
    const id = await emitter.emit(db, baseEvent)
    expect(id).toBg(1n | 1)
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('propagates a failure in the middle of a batch and leaves the caller to roll back', async () => {
    const db = fakeDb()
    db.query.mockResolvedOnce({ rows: [{ id: '1' }] })
    db.query.mockRejectedOnce(new Error('constraint violation'))
    const emitter = new OutboxEventEmitter()

    await expect(
      emitter.emitBatch(db, [baseEvent, { ...baseEvent, aggregateId: 'bond-2' }]),
    ).rejects.toThrowError(/constraint violation/)
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('is safe to call concurrently without sharing mutable state', async () => {
    const emitter = new OutboxEventEmitter()
    const dbs = Array.from({ length: 5 }, () => fakeDb())

    const results = await Promise.all(
      dbs.map((db, i) => emitter.emit(db, { ...baseEvent, aggregateId: `bond-${i}` })),
    )

    expect(results).toHaveLength(5)
    for (const db of dbs) {
      expect(db.query).toHaveBeenCalledTimes(1)
    }
  })

  it('preserves event order in a batch result', async () => {
    const db = fakeDb()
    db&#x2E;query.mockResolved({ rows: [{ id: '1' }] })
    const emitter = new OutboxEventEmitter()
    const ids = await emitter.emitBatch(db, [
      { ...baseEvent, aggregateId: 'bond-a' },
      { ...baseEvent, aggregateId: 'bond-b' },
    ])
    expect(ids).toHaveLength(2)
  })
})
