/**
 * Unit tests for the Horizon ingestion lifecycle transition matrix
 * (`src/listeners/horizonTransitions.ts`).
 *
 * Proves the *complete* decision table — every legal edge plus stale,
 * repeated, skipped (unknown-node), and out-of-order transitions — at the
 * pure logic layer, so the invariant is reviewable independent of any
 * repository implementation.
 */
import { describe, it, expect } from 'vitest'
import {
  HORIZON_INGESTION_TRANSITIONS,
  HorizonIngestionTransitionError,
  getAllowedIngestionTargets,
  getTerminalIngestionStates,
  isHorizonIngestionState,
  resolveIngestionTransition,
  validateIngestionTransition,
} from '../horizonTransitions.js'

describe('HORIZON_INGESTION_TRANSITIONS matrix', () => {
  it('accepts every legal lifecycle change', () => {
    expect(HORIZON_INGESTION_TRANSITIONS.isValid('active', 'slashed')).toBe(true)
    expect(HORIZON_INGESTION_TRANSITIONS.isValid('active', 'withdrawn')).toBe(true)
    expect(HORIZON_INGESTION_TRANSITIONS.isValid('slashed', 'withdrawn')).toBe(true)
  })

  it('rejects every illegal / out-of-order transition', () => {
    // Reverse edges — a bond can never go back to being live.
    expect(HORIZON_INGESTION_TRANSITIONS.isValid('slashed', 'active')).toBe(false)
    expect(HORIZON_INGESTION_TRANSITIONS.isValid('withdrawn', 'active')).toBe(false)
    // A fully withdrawn bond cannot be slashed on chain.
    expect(HORIZON_INGESTION_TRANSITIONS.isValid('withdrawn', 'slashed')).toBe(false)
    // Self-loops are handled by the enforcement layer, not the change matrix.
    expect(HORIZON_INGESTION_TRANSITIONS.isValid('active', 'active')).toBe(false)
    expect(HORIZON_INGESTION_TRANSITIONS.isValid('slashed', 'slashed')).toBe(false)
    expect(HORIZON_INGESTION_TRANSITIONS.isValid('withdrawn', 'withdrawn')).toBe(false)
  })

  it('treats withdrawn as the only terminal state', () => {
    expect(getTerminalIngestionStates()).toEqual(['withdrawn'])
    expect(getAllowedIngestionTargets('withdrawn')).toEqual([])
    expect(getAllowedIngestionTargets('active').sort()).toEqual(['slashed', 'withdrawn'])
    expect(getAllowedIngestionTargets('slashed')).toEqual(['withdrawn'])
  })

  it('describes the matrix deterministically for documentation/audit', () => {
    const description = HORIZON_INGESTION_TRANSITIONS.describe()
    expect(description).toContain('active → slashed')
    expect(description).toContain('active → withdrawn')
    expect(description).toContain('slashed → withdrawn')
  })

  it('validateIngestionTransition returns structured results', () => {
    expect(validateIngestionTransition('active', 'slashed')).toEqual({
      success: true,
      from: 'active',
      to: 'slashed',
    })
    const rejected = validateIngestionTransition('withdrawn', 'slashed')
    expect(rejected.success).toBe(false)
    expect(rejected.error).toContain('Invalid transition')
  })
})

describe('resolveIngestionTransition decision table', () => {
  it('accepts every legal edge as applied (caller must write)', () => {
    expect(resolveIngestionTransition('active', 'slashed')).toEqual({ status: 'applied' })
    expect(resolveIngestionTransition('active', 'withdrawn')).toEqual({ status: 'applied' })
    expect(resolveIngestionTransition('slashed', 'withdrawn')).toEqual({ status: 'applied' })
  })

  it('treats same-state redelivery as an idempotent no-op (replay safety)', () => {
    // Repeated events are the *normal* at-least-once case after a crash,
    // lease hand-off, or manual re-ingestion — they must never error and
    // never re-write state.
    expect(resolveIngestionTransition('active', 'active')).toEqual({
      status: 'noop',
      current: 'active',
    })
    expect(resolveIngestionTransition('slashed', 'slashed')).toEqual({
      status: 'noop',
      current: 'slashed',
    })
    expect(resolveIngestionTransition('withdrawn', 'withdrawn')).toEqual({
      status: 'noop',
      current: 'withdrawn',
    })
  })

  it('rejects stale / out-of-order transitions with INVALID_STATE_TRANSITION', () => {
    expect(resolveIngestionTransition('withdrawn', 'slashed')).toEqual({
      status: 'rejected',
      code: 'INVALID_STATE_TRANSITION',
      current: 'withdrawn',
      requested: 'slashed',
    })
    expect(resolveIngestionTransition('withdrawn', 'active')).toEqual({
      status: 'rejected',
      code: 'INVALID_STATE_TRANSITION',
      current: 'withdrawn',
      requested: 'active',
    })
    expect(resolveIngestionTransition('slashed', 'active')).toEqual({
      status: 'rejected',
      code: 'INVALID_STATE_TRANSITION',
      current: 'slashed',
      requested: 'active',
    })
  })

  it('rejects events for a node that has never been ingested (NODE_NOT_INGESTED)', () => {
    // An ingestion gap: the `bond` creation was never seen locally, so
    // materializing slashed/withdrawn state from nothing is unauthorized.
    expect(resolveIngestionTransition(null, 'slashed')).toEqual({
      status: 'rejected',
      code: 'NODE_NOT_INGESTED',
      current: null,
      requested: 'slashed',
    })
    expect(resolveIngestionTransition(undefined, 'withdrawn')).toEqual({
      status: 'rejected',
      code: 'NODE_NOT_INGESTED',
      current: null,
      requested: 'withdrawn',
    })
  })
})

describe('HorizonIngestionTransitionError', () => {
  it('carries structured, machine-readable rejection details', () => {
    const err = new HorizonIngestionTransitionError({
      code: 'INVALID_STATE_TRANSITION',
      nodeId: 'node-1',
      eventType: 'slash',
      current: 'withdrawn',
      requested: 'slashed',
    })
    expect(err.name).toBe('HorizonIngestionTransitionError')
    expect(err.code).toBe('INVALID_STATE_TRANSITION')
    expect(err.nodeId).toBe('node-1')
    expect(err.eventType).toBe('slash')
    expect(err.current).toBe('withdrawn')
    expect(err.requested).toBe('slashed')
    expect(err.message).toContain('node-1')
    expect(err.message).toContain('withdrawn')
    expect(err.message).toContain('slashed')

    const gap = new HorizonIngestionTransitionError({
      code: 'NODE_NOT_INGESTED',
      nodeId: 'node-2',
      eventType: 'withdrawal',
      current: null,
      requested: 'withdrawn',
    })
    expect(gap.message).toContain('never been ingested')
    expect(gap.message).toContain('(none)')
  })
})

describe('isHorizonIngestionState', () => {
  it('recognizes canonical states and rejects everything else', () => {
    expect(isHorizonIngestionState('active')).toBe(true)
    expect(isHorizonIngestionState('slashed')).toBe(true)
    expect(isHorizonIngestionState('withdrawn')).toBe(true)
    expect(isHorizonIngestionState('bonded')).toBe(false)
    expect(isHorizonIngestionState('ACTIVE')).toBe(false)
    expect(isHorizonIngestionState('')).toBe(false)
    expect(isHorizonIngestionState(null)).toBe(false)
    expect(isHorizonIngestionState(undefined)).toBe(false)
  })
})
