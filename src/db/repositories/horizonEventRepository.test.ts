import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb, type IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import { HorizonEventLedger, type HorizonEventRecordInput } from './horizonEventRepository.js'

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
