import { describe, it, expect, vi } from 'vitest'
import { OutboxEventEmitter } from './emitter.js'
import { tracingContext } from '../../utils/logger.js'
import type { Queryable } from '../repositories/queryable.js'
import type { CreateOutboxEvent } from './types.js'

function fakeDb() {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: '1' }] })
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
