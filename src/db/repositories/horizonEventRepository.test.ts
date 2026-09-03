import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb, type IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import {
  HorizonEventLedger,
  HorizonEventConflictError,
  canonicalEventPayload,
  type HorizonEventRecordInput,
} from './horizonEventRepository.js'

const DDL = `
  CREATE TABLE horizon_events (
    id           BIGSERIAL PRIMARY KEY,
    stream_name  TEXT NOT NULL,
    event_id     TEXT NOT NULL,
    paging_token TEXT NOT NULL,
    ledger_seq   BIGINT,
    event_type   TEXT NOT NULL,
    payload      JSONB NOT NULL,
    state_hash   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX uq_horizon_events_stream_event ON horizon_events (stream_name, event_id);
`

function input(overrides: Partial<HorizonEventRecordInput> = {}): HorizonEventRecordInput {
  return {
    streamName: 'bond_creation',
    eventId: 'op-1',
    pagingToken: '100',
    ledgerSeq: 100,
    eventType: 'create_bond',
    payload: {
      identity: { id: 'GADDR' },
      bond: { id: 'op-1', address: 'GADDR', amount: '1000', duration: '365' },
    },
    stateHash: 'abc123',
    ...overrides,
  }
}

describe('HorizonEventLedger', () => {
  let db: IMemoryDb
  let pool: Pool
  let ledger: HorizonEventLedger

  beforeEach(async () => {
    db = newDb()
    const pgMock = db.adapters.createPg()
    pool = new pgMock.Pool() as unknown as Pool
    await pool.query(DDL)
    ledger = new HorizonEventLedger(pool)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records a complete, versioned event with correlation fields', async () => {
    const created = await ledger.record(input())
    expect(created).toBe(true)

    const record = await ledger.findByStreamAndEvent('bond_creation', 'op-1')
    expect(record).not.toBeNull()
    expect(record!.streamName).toBe('bond_creation')
    expect(record!.eventId).toBe('op-1')
    expect(record!.pagingToken).toBe('100')
    expect(record!.ledgerSeq).toBe(100)
    expect(record!.eventType).toBe('create_bond')
    expect(record!.payload).toEqual(input().payload)
    expect(record!.stateHash).toBe('abc123')
  })

  it('is idempotent for repeated delivery of the same operation (at-least-once)', async () => {
    await ledger.record(input())
    await ledger.record(input())
    await ledger.record(input())

    // ON CONFLICT (stream_name, event_id) DO NOTHING — one row per (stream, event).
    const all = await ledger.list('bond_creation')
    expect(all).toHaveLength(1)
    expect(await ledger.count('bond_creation')).toBe(1)
  })

  it('lists records in documented ordering (ascending paging_token)', async () => {
    await ledger.record(input({ eventId: 'op-1', pagingToken: '100' }))
    await ledger.record(input({ eventId: 'op-2', pagingToken: '200' }))
    await ledger.record(input({ eventId: 'op-3', pagingToken: '300' }))

    const records = await ledger.list('bond_creation')
    expect(records.map((r) => r.pagingToken)).toEqual(['100', '200', '300'])
  })

  it('supports ordered resume after a paging token', async () => {
    await ledger.record(input({ eventId: 'op-1', pagingToken: '100' }))
    await ledger.record(input({ eventId: 'op-2', pagingToken: '200' }))
    await ledger.record(input({ eventId: 'op-3', pagingToken: '300' }))

    const after = await ledger.list('bond_creation', { afterPagingToken: '100' })
    expect(after.map((r) => r.eventId)).toEqual(['op-2', 'op-3'])
  })

  it('scopes counts and lists per stream', async () => {
    await ledger.record(input({ eventId: 'op-1' }))
    await ledger.record(input({ streamName: 'attestation', eventId: 'at-1' }))

    expect(await ledger.count('bond_creation')).toBe(1)
    expect(await ledger.count()).toBe(2)
    expect(await ledger.list('attestation')).toHaveLength(1)
  })

  it('rejects invalid paging tokens before reaching the database', async () => {
    await expect(
      ledger.record(input({ pagingToken: "1'; DROP TABLE horizon_events; --" }))
    ).rejects.toThrow('Invalid paging_token')
    await expect(ledger.record(input({ pagingToken: 'bad-token' }))).rejects.toThrow('Invalid paging_token')
  })

  it('rejects empty correlation identifiers', async () => {
    await expect(ledger.record(input({ eventId: '  ' }))).rejects.toThrow('requires streamName and eventId')
    await expect(ledger.record(input({ streamName: '' }))).rejects.toThrow('requires streamName and eventId')
  })

  it('writes through a caller-provided client so it joins the caller transaction', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    const client = { query: clientQuery } as unknown as Pool

    const created = await ledger.record(input(), client as never)
    expect(created).toBe(true)

    const [sql, params] = clientQuery.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('INSERT INTO horizon_events')
    expect(String(sql)).toContain('ON CONFLICT (stream_name, event_id) DO NOTHING')
    expect(params[0]).toBe('bond_creation')
    expect(params[1]).toBe('op-1')
    expect(params[2]).toBe('100')
  })
})

describe('HorizonEventLedger.claim — durable request identity and conflicting reuse (#1261)', () => {
  let db: IMemoryDb
  let pool: Pool
  let ledger: HorizonEventLedger

  beforeEach(async () => {
    db = newDb()
    const pgMock = db.adapters.createPg()
    pool = new pgMock.Pool() as unknown as Pool
    await pool.query(DDL)
    ledger = new HorizonEventLedger(pool)
  })

  it('inserts a fresh operation id exactly once (first processing)', async () => {
    expect(await ledger.claim(input())).toBe('inserted')
    expect(await ledger.count('bond_creation')).toBe(1)
  })

  it('reports a deterministic duplicate for an identical replay of the same operation', async () => {
    await ledger.claim(input())
    // Identical payload, identical key — the retry must be a no-op, never a
    // second insert, never an error.
    expect(await ledger.claim(input())).toBe('duplicate')
    expect(await ledger.count('bond_creation')).toBe(1)
  })

  it('rejects conflicting reuse: same operation id, materially different payload', async () => {
    await ledger.claim(input())

    // Same key (op-1) but a different amount: a materially different operation
    // claiming an already-committed request key. Must be rejected
    // deterministically, and the committed record must remain untouched.
    const conflicting = input({
      payload: {
        identity: { id: 'GADDR' },
        bond: { id: 'op-1', address: 'GADDR', amount: '999999999', duration: '365' },
      },
      stateHash: 'tampered',
    })
    await expect(ledger.claim(conflicting)).rejects.toBeInstanceOf(HorizonEventConflictError)
    await expect(ledger.claim(conflicting)).rejects.toMatchObject({
      code: 'EVENT_ID_CONFLICT',
      eventId: 'op-1',
      streamName: 'bond_creation',
    })

    const committed = await ledger.findByStreamAndEvent('bond_creation', 'op-1')
    expect(committed?.payload).toEqual(input().payload)
    expect(committed?.stateHash).toBe('abc123')
    expect(await ledger.count('bond_creation')).toBe(1)
  })

  it('treats key-order-only payload differences as the same operation', async () => {
    await ledger.claim(input())
    const reordered = input({
      payload: {
        bond: { id: 'op-1', address: 'GADDR', duration: '365', amount: '1000' },
        identity: { id: 'GADDR' },
      },
    })
    expect(await ledger.claim(reordered)).toBe('duplicate')
  })

  it('scopes claims per stream: the same event id is independent across streams', async () => {
    expect(await ledger.claim(input())).toBe('inserted')
    expect(await ledger.claim(input({ streamName: 'attestation' }))).toBe('inserted')
    expect(await ledger.count()).toBe(2)
  })

  it('issues the idempotent INSERT through a caller-provided client (joins the transaction)', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    const client = { query: clientQuery } as unknown as Pool

    // No committed row (the SELECT finds none) → the claim must reach the
    // idempotent INSERT on the caller's client, never on the pool.
    const outcome = await ledger.claim(input(), client as never)
    expect(outcome).toBe('inserted')

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const insertSql = sqls.find((sql) => sql.includes('INSERT INTO horizon_events'))
    expect(insertSql).toBeDefined()
    expect(insertSql).toContain('ON CONFLICT (stream_name, event_id) DO NOTHING')
  })

  it('decides duplicate/conflict from the committed record without issuing an INSERT', async () => {
    await ledger.claim(input())

    const client = await pool.connect()
    try {
      const querySpy = vi.spyOn(client, 'query')

      // Identical payload → duplicate, resolved by read only — the write path
      // must not be touched for an already-committed operation.
      expect(await ledger.claim(input(), client)).toBe('duplicate')

      const conflicting = input({
        payload: {
          identity: { id: 'GADDR' },
          bond: { id: 'op-1', address: 'GADDR', amount: '42', duration: '365' },
        },
      })
      await expect(ledger.claim(conflicting, client)).rejects.toMatchObject({
        code: 'EVENT_ID_CONFLICT',
      })

      const sqls = querySpy.mock.calls.map(([sql]) => String(sql))
      expect(sqls.some((sql) => sql.includes('INSERT INTO horizon_events'))).toBe(false)
      expect(await ledger.count('bond_creation')).toBe(1)
    } finally {
      client.release()
    }
  })
})

describe('canonicalEventPayload', () => {
  it('is stable regardless of key insertion order', () => {
    const a = canonicalEventPayload({ identity: { id: 'X' }, bond: { amount: '1' } })
    const b = canonicalEventPayload({ bond: { amount: '1' }, identity: { id: 'X' } })
    expect(a).toBe(b)
  })

  it('differs when any semantic value differs', () => {
    expect(canonicalEventPayload({ amount: '100' })).not.toBe(
      canonicalEventPayload({ amount: '101' })
    )
  })
})
