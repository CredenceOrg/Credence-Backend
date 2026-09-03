/**
 * Integration-boundary tests for Horizon bond-creation ingestion replay and
 * idempotency (issue #1261).
 *
 * These tests drive the REAL `applyBondCreationEvent` processor — the exact
 * code path `subscribeBondCreationEvents` runs per Horizon operation —
 * against a stateful in-memory Postgres (pg-mem) that holds the real
 * `horizon_events` ledger, `identities` state, and `horizon_cursors`
 * checkpoint tables. They prove the correctness invariant at the actual
 * business-effect boundary:
 *
 *   - a valid operation is applied exactly once (`applied`);
 *   - an identical redelivery is a deterministic no-op (`replayed`) with no
 *     second business effect;
 *   - reusing an operation id for a materially different operation is
 *     rejected (`HorizonEventConflictError`) without touching the committed
 *     record or its state;
 *   - retrying after a mid-transaction failure converges to exactly one
 *     committed effect;
 *   - reordered/stale deliveries (new operation id at or behind the
 *     checkpoint) are rejected without regressing authoritative state;
 *   - replaying an already-processed range converges to the authoritative
 *     state and never duplicates ledger rows;
 *   - concurrent delivery of the same operation commits a single effect.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { newDb, type IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import {
  applyBondCreationEvent,
  HorizonEventStaleError,
  type BondCreationIngestionEvent,
} from '../horizonBondIngestion.js'
import { HorizonEventLedger, HorizonEventConflictError } from '../../db/repositories/horizonEventRepository.js'
import { upsertBond } from '../../services/identityService.js'

// Cut the cache-invalidation graph (middleware/metrics) that reputationService
// would otherwise pull in; the processor under test does not need it.
vi.mock('../../services/reputationService.js', () => ({
  invalidateTrustScoreCache: vi.fn().mockResolvedValue(undefined),
}))

// Wrap the real upsertBond so individual calls can be failed without losing
// the real implementation for every other call.
vi.mock('../../services/identityService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/identityService.js')>()
  return {
    ...actual,
    upsertBond: vi.fn(actual.upsertBond),
  }
})

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

  CREATE TABLE identities (
    address       TEXT PRIMARY KEY,
    bonded_amount TEXT NOT NULL DEFAULT '0',
    bond_start    TIMESTAMPTZ,
    bond_duration INTEGER,
    active        BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE horizon_cursors (
    stream_name     TEXT PRIMARY KEY,
    paging_token    TEXT NOT NULL,
    last_checkpoint TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`

const ADDRESS = 'GABC123456789012345678901234567890123456789012345678901234'
const ADDRESS2 = 'GDEF123456789012345678901234567890123456789012345678901234'

function bondEvent(overrides: Partial<BondCreationIngestionEvent> = {}): BondCreationIngestionEvent {
  return {
    operationId: 'op-1',
    pagingToken: '100',
    identity: { id: ADDRESS },
    bond: { id: 'op-1', address: ADDRESS, amount: '1000', duration: '365' },
    ...overrides,
  }
}

/** Build an event whose identity id always matches its bond address. */
function eventFor(
  operationId: string,
  pagingToken: string,
  address: string,
  amount: string,
): BondCreationIngestionEvent {
  return bondEvent({
    operationId,
    pagingToken,
    identity: { id: address },
    bond: { id: operationId, address, amount, duration: '365' },
  })
}

describe('applyBondCreationEvent — replay/idempotency boundary (#1261)', () => {
  let db: IMemoryDb
  let pool: Pool
  let ledger: HorizonEventLedger

  /** Clock that strictly increases per NOW() call — makes "no write" observable. */
  function installMonotonicClock(startMs: number) {
    let t = startMs
    db.public.registerFunction({
      name: 'now',
      returns: 'timestamptz',
      implementation: () => new Date((t += 1000)),
    })
  }

  beforeEach(async () => {
    db = newDb()
    installMonotonicClock(Date.UTC(2026, 0, 1))
    const pgMock = db.adapters.createPg()
    pool = new pgMock.Pool() as unknown as Pool
    await pool.query(DDL)
    ledger = new HorizonEventLedger(pool)
    vi.clearAllMocks()
  })

  async function identityState(address: string) {
    const { rows } = await pool.query(
      `SELECT address, bonded_amount, bond_duration, active, updated_at
         FROM identities WHERE address = $1`,
      [address]
    )
    return rows[0] ?? null
  }

  async function checkpoint(): Promise<string | null> {
    const { rows } = await pool.query(
      `SELECT paging_token FROM horizon_cursors WHERE stream_name = 'bond_creation'`
    )
    return rows[0]?.paging_token ?? null
  }

  it('applies a valid operation exactly once and persists state, ledger, and cursor', async () => {
    const outcome = await applyBondCreationEvent({ pool, event: bondEvent() })
    expect(outcome).toBe('applied')

    const identity = await identityState(ADDRESS)
    expect(identity).not.toBeNull()
    expect(identity.bonded_amount).toBe('1000')
    expect(identity.bond_duration).toBe(365)
    expect(identity.active).toBe(true)

    expect(await ledger.count('bond_creation')).toBe(1)
    const record = await ledger.findByStreamAndEvent('bond_creation', 'op-1')
    expect(record?.eventType).toBe('create_bond')
    expect(record?.pagingToken).toBe('100')
    expect(record?.payload).toEqual({
      identity: { id: ADDRESS },
      bond: { id: 'op-1', address: ADDRESS, amount: '1000', duration: '365' },
    })

    expect(await checkpoint()).toBe('100')
  })

  it('treats an identical redelivery as a deterministic no-op (no second business effect)', async () => {
    expect(await applyBondCreationEvent({ pool, event: bondEvent() })).toBe('applied')
    const afterFirst = await identityState(ADDRESS)

    // Simulate at-least-once redelivery of the exact same operation after the
    // first commit (e.g. a lost provider response followed by a retry).
    expect(await applyBondCreationEvent({ pool, event: bondEvent() })).toBe('replayed')

    const afterSecond = await identityState(ADDRESS)
    expect(await ledger.count('bond_creation')).toBe(1)
    // The retry must not re-run the business effect: no state write at all.
    expect(afterSecond.updated_at).toEqual(afterFirst.updated_at)
    expect(afterSecond.bonded_amount).toBe('1000')
    expect(await checkpoint()).toBe('100')
  })

  it('rejects conflicting reuse of an operation id with a materially different payload', async () => {
    expect(await applyBondCreationEvent({ pool, event: bondEvent() })).toBe('applied')

    // Same durable request key (op-1) but a materially different operation.
    const conflicting = bondEvent({
      bond: { id: 'op-1', address: ADDRESS, amount: '999999999', duration: '365' },
    })
    await expect(
      applyBondCreationEvent({ pool, event: conflicting })
    ).rejects.toBeInstanceOf(HorizonEventConflictError)

    // The committed record and its state are untouched; the second operation
    // was never applied and left nothing behind.
    const record = await ledger.findByStreamAndEvent('bond_creation', 'op-1')
    expect(record?.payload).toEqual({
      identity: { id: ADDRESS },
      bond: { id: 'op-1', address: ADDRESS, amount: '1000', duration: '365' },
    })
    expect((await identityState(ADDRESS)).bonded_amount).toBe('1000')
    expect(await ledger.count('bond_creation')).toBe(1)
    expect(await checkpoint()).toBe('100')
  })

  it('retries cleanly after a transient connection failure — exactly one committed effect', async () => {
    // The provider/DB connection fails before any work happens (nothing can be
    // partially written). A bounded retry of the same logical operation must
    // then apply the effect exactly once.
    const connectSpy = vi.spyOn(pool, 'connect').mockRejectedValueOnce(
      new Error('connection lost')
    )
    await expect(applyBondCreationEvent({ pool, event: bondEvent() })).rejects.toThrow(
      'connection lost'
    )

    expect(await applyBondCreationEvent({ pool, event: bondEvent() })).toBe('applied')

    // Exactly one committed effect: one ledger record and correct state.
    expect(await ledger.count('bond_creation')).toBe(1)
    expect((await identityState(ADDRESS)).bonded_amount).toBe('1000')
    expect(await checkpoint()).toBe('100')
    expect(connectSpy).toHaveBeenCalledTimes(2)
  })

  it('rolls back the whole transaction and commits nothing when a mid-transaction write fails', async () => {
    // A write inside the transaction fails (after the claim): the processor
    // must issue ROLLBACK, never COMMIT, and surface the error — no partial
    // state may be acknowledged as committed.
    const bondSpy = upsertBond as Mock
    bondSpy.mockRejectedValueOnce(new Error('simulated DB write failure'))

    const client = await pool.connect()
    const querySpy = vi.spyOn(client, 'query')
    const connectSpy = vi.spyOn(pool, 'connect').mockResolvedValueOnce(client)

    await expect(applyBondCreationEvent({ pool, event: bondEvent() })).rejects.toThrow(
      'simulated DB write failure'
    )

    const sqls = querySpy.mock.calls.map(([sql]) => String(sql))
    expect(sqls).toContain('BEGIN')
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
    expect(connectSpy).toHaveBeenCalledTimes(1)
    client.release()
  })

  it('converges when a committed response is lost and the operation is retried', async () => {
    // First attempt commits; the caller loses the response (timeout) and
    // retries the exact same logical operation.
    expect(await applyBondCreationEvent({ pool, event: bondEvent() })).toBe('applied')
    expect(await applyBondCreationEvent({ pool, event: bondEvent() })).toBe('replayed')

    expect(await ledger.count('bond_creation')).toBe(1)
    expect((await identityState(ADDRESS)).bonded_amount).toBe('1000')
  })

  it('rejects an uncommitted operation that arrives behind the checkpoint (stale/reordered)', async () => {
    // op-2 at token 300 is ingested first.
    expect(
      await applyBondCreationEvent({
        pool,
        event: eventFor('op-2', '300', ADDRESS, '2000'),
      })
    ).toBe('applied')
    expect(await checkpoint()).toBe('300')

    // A *new* operation id arriving at token 100 (behind the checkpoint)
    // signals a reorg/gap anomaly. It must be rejected without any write so
    // authoritative state is never regressed by out-of-order delivery.
    await expect(
      applyBondCreationEvent({
        pool,
        event: eventFor('op-stale', '100', ADDRESS, '1'),
      })
    ).rejects.toBeInstanceOf(HorizonEventStaleError)

    expect(await ledger.count('bond_creation')).toBe(1)
    expect((await identityState(ADDRESS)).bonded_amount).toBe('2000')
    expect(await checkpoint()).toBe('300')
  })

  it('replays an already-committed range as verified duplicates and converges', async () => {
    const a = eventFor('op-a', '100', ADDRESS, '1000')
    const b = eventFor('op-b', '200', ADDRESS2, '2000')
    const c = eventFor('op-c', '300', ADDRESS, '3000')

    for (const event of [a, b, c]) {
      expect(await applyBondCreationEvent({ pool, event })).toBe('applied')
    }
    expect(await checkpoint()).toBe('300')

    // Full replay of the already-processed range (e.g. re-ingestion after a
    // cursor reset): every event is a verified duplicate no-op.
    for (const event of [a, b, c]) {
      expect(await applyBondCreationEvent({ pool, event })).toBe('replayed')
    }

    expect(await ledger.count('bond_creation')).toBe(3)
    expect(await checkpoint()).toBe('300')
    // Authoritative state matches the fold of the ledger in token order.
    expect((await identityState(ADDRESS)).bonded_amount).toBe('3000')
    expect((await identityState(ADDRESS2)).bonded_amount).toBe('2000')
  })

  it('commits a single effect when the same operation is delivered concurrently', async () => {
    const event = bondEvent()
    const outcomes = await Promise.all([
      applyBondCreationEvent({ pool, event }),
      applyBondCreationEvent({ pool, event }),
    ])

    // At least one delivery applied the effect; every delivery returned a
    // deterministic result (never an error).
    expect(outcomes).toContain('applied')
    expect(outcomes.every((o) => o === 'applied' || o === 'replayed')).toBe(true)

    // Exactly one committed ledger record and one correct final state.
    expect(await ledger.count('bond_creation')).toBe(1)
    expect((await identityState(ADDRESS)).bonded_amount).toBe('1000')
    expect(await checkpoint()).toBe('100')
  })

  it('leaves no state behind when the operation is rejected as stale (no partial writes)', async () => {
    // Seed a later checkpoint without the stale op present.
    expect(
      await applyBondCreationEvent({
        pool,
        event: eventFor('op-9', '900', ADDRESS2, '9000'),
      })
    ).toBe('applied')

    await expect(
      applyBondCreationEvent({
        pool,
        event: eventFor('op-stale', '500', ADDRESS2, '500'),
      })
    ).rejects.toBeInstanceOf(HorizonEventStaleError)

    // The stale operation left neither a ledger record nor a state change.
    expect(await ledger.findByStreamAndEvent('bond_creation', 'op-stale')).toBeNull()
    expect((await identityState(ADDRESS2)).bonded_amount).toBe('9000')
    expect(await checkpoint()).toBe('900')
  })
})
