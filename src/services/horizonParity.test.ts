import { describe, it, expect } from 'vitest'
import type { HorizonEventRecord } from '../db/repositories/horizonEventRepository.js'
import {
  applyBondEvents,
  computeStateHash,
  extractLedgerSeq,
  stateFromBondEvent,
  verifyHorizonParity,
  type BondCreationEventPayload,
  type IdentityStateView,
  type IdentityStateReader,
} from './horizonParity.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

function bondEvent(overrides: Partial<HorizonEventRecord> = {}): HorizonEventRecord {
  return {
    id: 1,
    streamName: 'bond_creation',
    eventId: 'op-1',
    pagingToken: '100',
    ledgerSeq: 100,
    eventType: 'create_bond',
    payload: {
      identity: { id: 'GADDR' },
      bond: { id: 'op-1', address: 'GADDR', amount: '1000', duration: '365' },
    },
    stateHash: null,
    ...overrides,
  }
}

function state(overrides: Partial<IdentityStateView> = {}): IdentityStateView {
  return {
    address: 'GADDR',
    bondedAmount: '1000',
    hasBondStart: true,
    bondDuration: 365,
    active: true,
    ...overrides,
  }
}

function readerOf(states: IdentityStateView[]): IdentityStateReader {
  const byAddress = new Map(states.map((s) => [s.address, s]))
  return { get: async (address) => byAddress.get(address) ?? null }
}

// ── computeStateHash / stateFromBondEvent / extractLedgerSeq ────────────────

describe('computeStateHash', () => {
  it('is deterministic for identical states', () => {
    expect(computeStateHash(state())).toBe(computeStateHash(state()))
  })

  it('changes when any semantic field changes', () => {
    const base = computeStateHash(state())
    expect(computeStateHash(state({ bondedAmount: '2000' }))).not.toBe(base)
    expect(computeStateHash(state({ active: false }))).not.toBe(base)
    expect(computeStateHash(state({ bondDuration: null }))).not.toBe(base)
  })
})

describe('stateFromBondEvent', () => {
  it('projects a bond event payload into the expected identity state', () => {
    const payload = bondEvent().payload as unknown as BondCreationEventPayload
    expect(stateFromBondEvent(payload)).toEqual({
      address: 'GADDR',
      bondedAmount: '1000',
      hasBondStart: true,
      bondDuration: 365,
      active: true,
    })
  })

  it('maps null / non-numeric duration to null', () => {
    const payload = bondEvent({
      payload: {
        identity: { id: 'GADDR' },
        bond: { id: 'op-1', address: 'GADDR', amount: '1000', duration: null },
      },
    }).payload
    expect(stateFromBondEvent(payload as unknown as BondCreationEventPayload).bondDuration).toBeNull()
  })
})

describe('extractLedgerSeq', () => {
  it('parses a numeric paging token', () => {
    expect(extractLedgerSeq('192694205464072192')).toBe(192694205464072192)
  })

  it('parses the ledger component of a hyphenated token', () => {
    expect(extractLedgerSeq('1234-0000000001-0000000001')).toBe(1234)
  })

  it('returns null for opaque tokens', () => {
    expect(extractLedgerSeq('now')).toBeNull()
  })
})

// ── applyBondEvents ─────────────────────────────────────────────────────────

describe('applyBondEvents', () => {
  it('folds events in paging-token order with last-event-wins for amount', () => {
    const events = [
      bondEvent({ id: 1, eventId: 'op-1', pagingToken: '100', payload: { identity: { id: 'GADDR' }, bond: { id: 'op-1', address: 'GADDR', amount: '1000', duration: '365' } } }),
      bondEvent({ id: 2, eventId: 'op-2', pagingToken: '200', payload: { identity: { id: 'GADDR' }, bond: { id: 'op-2', address: 'GADDR', amount: '2000', duration: '730' } } }),
    ]
    const result = applyBondEvents(events)
    expect(result.get('GADDR')).toEqual({
      address: 'GADDR',
      bondedAmount: '2000',
      hasBondStart: true,
      bondDuration: 730,
      active: true,
    })
  })

  it('converges to the same answer regardless of input order (sorting is internal)', () => {
    const later = bondEvent({ id: 2, eventId: 'op-2', pagingToken: '200', payload: { identity: { id: 'GADDR' }, bond: { id: 'op-2', address: 'GADDR', amount: '2000', duration: '730' } } })
    const earlier = bondEvent({ id: 1, eventId: 'op-1', pagingToken: '100', payload: { identity: { id: 'GADDR' }, bond: { id: 'op-1', address: 'GADDR', amount: '1000', duration: '365' } } })
    const forward = applyBondEvents([earlier, later])
    const reversed = applyBondEvents([later, earlier])
    expect(forward.get('GADDR')).toEqual(reversed.get('GADDR'))
  })

  it('folds duplicate event ids once (at-least-once replay is idempotent)', () => {
    const events = [
      bondEvent({ id: 1, eventId: 'op-1', pagingToken: '100', payload: { identity: { id: 'GADDR' }, bond: { id: 'op-1', address: 'GADDR', amount: '1000', duration: '365' } } }),
      bondEvent({ id: 2, eventId: 'op-1', pagingToken: '100', payload: { identity: { id: 'GADDR' }, bond: { id: 'op-1', address: 'GADDR', amount: '1000', duration: '365' } } }),
    ]
    const result = applyBondEvents(events)
    expect(result.get('GADDR')?.bondedAmount).toBe('1000')
  })

  it('ignores non-create_bond events', () => {
    const events = [bondEvent({ eventType: 'withdrawal' })]
    expect(applyBondEvents(events).size).toBe(0)
  })
})

// ── verifyHorizonParity ─────────────────────────────────────────────────────

describe('verifyHorizonParity', () => {
  const streamName = 'bond_creation'

  it('reports valid when events and committed state agree (normal conditions)', async () => {
    const events = [bondEvent({ stateHash: computeStateHash(state()) })]
    const report = await verifyHorizonParity({
      streamName,
      events,
      states: readerOf([state()]),
    })
    expect(report.valid).toBe(true)
    expect(report.matchedAddresses).toBe(1)
    expect(report.findings).toEqual([])
  })

  it('detects state drift: DB state diverges from the event ledger', async () => {
    const events = [bondEvent({ stateHash: computeStateHash(state()) })]
    const report = await verifyHorizonParity({
      streamName,
      events,
      states: readerOf([state({ bondedAmount: '9999' })]),
    })
    expect(report.valid).toBe(false)
    const finding = report.findings.find((f) => f.kind === 'state_mismatch')
    expect(finding).toBeDefined()
    expect(finding!.address).toBe('GADDR')
    expect(finding!.detail).toContain('bondedAmount')
  })

  it('detects a tampered record: recorded state_hash does not match payload', async () => {
    const events = [bondEvent({ stateHash: 'deadbeef' })]
    const report = await verifyHorizonParity({
      streamName,
      events,
      states: readerOf([state()]),
    })
    const finding = report.findings.find((f) => f.kind === 'record_hash_mismatch')
    expect(finding).toBeDefined()
    expect(finding!.eventId).toBe('op-1')
  })

  it('detects an event without committed state (partial write)', async () => {
    const events = [bondEvent({ stateHash: computeStateHash(state()) })]
    const report = await verifyHorizonParity({
      streamName,
      events,
      states: readerOf([]),
    })
    expect(report.findings.some((f) => f.kind === 'event_without_state')).toBe(true)
    expect(report.valid).toBe(false)
  })

  it('detects committed state with no accounting event (silent gap)', async () => {
    const report = await verifyHorizonParity({
      streamName,
      events: [],
      states: readerOf([state({ bondedAmount: '5000' })]),
      knownAddresses: ['GADDR'],
    })
    const finding = report.findings.find((f) => f.kind === 'state_without_event')
    expect(finding).toBeDefined()
    expect(finding!.address).toBe('GADDR')
    expect(report.valid).toBe(false)
  })

  it('does not flag a zero-state identity with no event (no drift)', async () => {
    const report = await verifyHorizonParity({
      streamName,
      events: [],
      states: readerOf([state({ bondedAmount: '0', active: false, hasBondStart: false })]),
      knownAddresses: ['GADDR'],
    })
    expect(report.valid).toBe(true)
  })

  it('reports across multiple addresses independently', async () => {
    const events = [
      bondEvent({ id: 1, eventId: 'op-1', pagingToken: '100', payload: { identity: { id: 'GADDR' }, bond: { id: 'op-1', address: 'GADDR', amount: '1000', duration: '365' } }, stateHash: computeStateHash(state()) }),
      bondEvent({ id: 2, eventId: 'op-2', pagingToken: '200', payload: { identity: { id: 'GBADDR' }, bond: { id: 'op-2', address: 'GBADDR', amount: '2000', duration: '365' } }, stateHash: computeStateHash(state({ address: 'GBADDR', bondedAmount: '2000' })) }),
    ]
    const report = await verifyHorizonParity({
      streamName,
      events,
      states: readerOf([
        state(),
        state({ address: 'GBADDR', bondedAmount: '2000' }),
      ]),
    })
    expect(report.valid).toBe(true)
    expect(report.totalAddresses).toBe(2)
    expect(report.matchedAddresses).toBe(2)
  })
})
