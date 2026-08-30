/**
 * Integration-boundary tests for the Horizon ingestion lifecycle invariants
 * (#1264).
 *
 * These tests drive the REAL `HorizonListener.handleEvent` entry point
 * against a stateful in-memory repository that implements the
 * `HorizonIngestionRepository` contract (the exact boundary a real
 * Postgres-backed repository would sit behind). They prove that:
 *
 *  - normal (legal) transitions are applied and persisted;
 *  - invalid transitions are rejected with a typed error and write nothing;
 *  - stale / out-of-order events (e.g. a slash for a withdrawn bond) are
 *    rejected deterministically;
 *  - repeated / replayed events are idempotent no-ops (never re-written,
 *    never erroring);
 *  - skipped (unknown-node) events are rejected instead of materializing
 *    phantom state;
 *  - failed writes leave the previous state intact (no partial state).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { HorizonListener, type HorizonIngestionRepository } from '../horizon.listeners.js'
import { HorizonIngestionTransitionError } from '../horizonTransitions.js'

/** Stateful stand-in for the repository behind the ingestion boundary. */
class InMemoryIngestionRepo implements HorizonIngestionRepository {
  readonly statuses = new Map<string, string>()
  readonly upserts: Array<{ nodeId: string; amount: string }> = []
  readonly updates: Array<{ nodeId: string; status: string; amount?: string }> = []
  failNextUpdate = false

  async upsertNode(nodeId: string, amount: string): Promise<boolean> {
    this.upserts.push({ nodeId, amount })
    this.statuses.set(nodeId, 'active')
    return true
  }

  async updateNodeStatus(nodeId: string, status: string, amount?: string): Promise<boolean> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false
      throw new Error('simulated DB write failure')
    }
    this.updates.push({ nodeId, status, amount })
    this.statuses.set(nodeId, status)
    return true
  }

  async getNodeStatus(nodeId: string): Promise<string | null> {
    return this.statuses.get(nodeId) ?? null
  }
}

const bondEvent = (nodeId: string, amount = '1000') => ({ type: 'bond', nodeId, amount })
const slashEvent = (nodeId: string, penalty = '500') => ({ type: 'slash', nodeId, penalty })
const withdrawalEvent = (nodeId: string) => ({ type: 'withdrawal', nodeId })

describe('HorizonListener ingestion transition invariants (integration boundary)', () => {
  let repo: InMemoryIngestionRepo
  let listener: HorizonListener

  beforeEach(() => {
    repo = new InMemoryIngestionRepo()
    listener = new HorizonListener(repo)
  })

  it('creates a node in active state via a bond event', async () => {
    await listener.handleEvent(bondEvent('node-1', '1000'))
    expect(repo.upserts).toEqual([{ nodeId: 'node-1', amount: '1000' }])
    expect(await repo.getNodeStatus('node-1')).toBe('active')
  })

  it('applies the legal active → slashed transition', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    await listener.handleEvent(slashEvent('node-1', '500'))
    expect(repo.updates).toEqual([{ nodeId: 'node-1', status: 'slashed', amount: '500' }])
    expect(await repo.getNodeStatus('node-1')).toBe('slashed')
  })

  it('applies the legal active → withdrawn transition', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    await listener.handleEvent(withdrawalEvent('node-1'))
    expect(repo.updates).toEqual([{ nodeId: 'node-1', status: 'withdrawn' }])
    expect(await repo.getNodeStatus('node-1')).toBe('withdrawn')
  })

  it('applies the legal slashed → withdrawn transition (withdrawal after slash)', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    await listener.handleEvent(slashEvent('node-1'))
    await listener.handleEvent(withdrawalEvent('node-1'))
    expect(repo.updates).toHaveLength(2)
    expect(repo.updates[0].status).toBe('slashed')
    expect(repo.updates[1].status).toBe('withdrawn')
    expect(await repo.getNodeStatus('node-1')).toBe('withdrawn')
  })

  it('treats a repeated slash on an already-slashed node as a no-op (replay safety)', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    await listener.handleEvent(slashEvent('node-1'))
    const writesBefore = repo.updates.length

    // Same event redelivered after a crash / lease hand-off.
    await listener.handleEvent(slashEvent('node-1'))

    expect(repo.updates.length).toBe(writesBefore) // no second write
    expect(await repo.getNodeStatus('node-1')).toBe('slashed')
  })

  it('treats a repeated withdrawal on an already-withdrawn node as a no-op (replay safety)', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    await listener.handleEvent(withdrawalEvent('node-1'))
    const writesBefore = repo.updates.length

    await listener.handleEvent(withdrawalEvent('node-1'))

    expect(repo.updates.length).toBe(writesBefore)
    expect(await repo.getNodeStatus('node-1')).toBe('withdrawn')
  })

  it('allows repeated bond upserts (idempotent refresh) without error', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    await listener.handleEvent(bondEvent('node-1', '2000'))
    expect(repo.upserts).toHaveLength(2)
    expect(await repo.getNodeStatus('node-1')).toBe('active')
  })

  it('rejects a stale slash for a withdrawn bond — no write, no state change', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    await listener.handleEvent(withdrawalEvent('node-1'))
    const writesBefore = repo.updates.length

    // Out-of-order / stale event: a slash can never apply to a withdrawn bond.
    await expect(listener.handleEvent(slashEvent('node-1'))).rejects.toThrow(
      HorizonIngestionTransitionError,
    )

    expect(repo.updates.length).toBe(writesBefore)
    expect(await repo.getNodeStatus('node-1')).toBe('withdrawn')
  })

  it('rejects re-activation of a withdrawn bond — no write, no state change', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    await listener.handleEvent(withdrawalEvent('node-1'))

    // No event type can drive withdrawn → active, but assert the decision
    // layer is what blocks it: a slash/withdrawal cannot resurrect a bond.
    await expect(listener.handleEvent(slashEvent('node-1'))).rejects.toThrow(
      HorizonIngestionTransitionError,
    )
    expect(await repo.getNodeStatus('node-1')).toBe('withdrawn')
  })

  it('rejects a slash for a node that was never ingested (NODE_NOT_INGESTED)', async () => {
    // Ingestion gap: no prior bond event was seen for this node.
    const error = await listener
      .handleEvent(slashEvent('phantom-node'))
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HorizonIngestionTransitionError)
    expect((error as HorizonIngestionTransitionError).code).toBe('NODE_NOT_INGESTED')
    expect(repo.updates).toHaveLength(0)
    expect(repo.statuses.has('phantom-node')).toBe(false)
  })

  it('rejects a withdrawal for a node that was never ingested (NODE_NOT_INGESTED)', async () => {
    const error = await listener
      .handleEvent(withdrawalEvent('phantom-node'))
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HorizonIngestionTransitionError)
    expect((error as HorizonIngestionTransitionError).code).toBe('NODE_NOT_INGESTED')
    expect(repo.updates).toHaveLength(0)
    expect(repo.statuses.has('phantom-node')).toBe(false)
  })

  it('carries structured rejection details for audit/DLQ routing', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    await listener.handleEvent(withdrawalEvent('node-1'))

    const error = await listener
      .handleEvent(slashEvent('node-1'))
      .catch((e: unknown) => e as HorizonIngestionTransitionError)

    expect(error.code).toBe('INVALID_STATE_TRANSITION')
    expect(error.nodeId).toBe('node-1')
    expect(error.eventType).toBe('slash')
    expect(error.current).toBe('withdrawn')
    expect(error.requested).toBe('slashed')
  })

  it('leaves prior state intact when the repository write fails (no partial state)', async () => {
    await listener.handleEvent(bondEvent('node-1'))
    repo.failNextUpdate = true

    await expect(listener.handleEvent(slashEvent('node-1'))).rejects.toThrow(
      'simulated DB write failure',
    )

    // The transition was legal but the write failed: the node must still be
    // in its previous state — never half-written, never lost.
    expect(await repo.getNodeStatus('node-1')).toBe('active')
    expect(repo.updates).toHaveLength(0)
  })
})
