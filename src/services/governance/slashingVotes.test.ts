import { describe, it, expect, beforeEach } from 'vitest'
import {
  createSlashRequest,
  submitVote,
  getSlashRequest,
  listSlashRequests,
  _resetStore,
} from './slashingVotes.js'

beforeEach(() => {
  _resetStore()
})

// ── createSlashRequest ────────────────────────────────────────────────────────

describe('createSlashRequest', () => {
  it('creates a request with default threshold and totalSigners', () => {
    const req = createSlashRequest({
      targetAddress: '0xABC',
      reason: 'misbehaviour',
      requestedBy: 'voter1',
    })
    expect(req.id).toBeTruthy()
    expect(req.targetAddress).toBe('0xABC')
    expect(req.reason).toBe('misbehaviour')
    expect(req.requestedBy).toBe('voter1')
    expect(req.status).toBe('pending')
    expect(req.votes).toHaveLength(0)
    expect(req.threshold).toBe(3)
    expect(req.totalSigners).toBe(5)
  })

  it('respects custom threshold and totalSigners', () => {
    const req = createSlashRequest({
      targetAddress: '0xDEF',
      reason: 'fraud',
      requestedBy: 'admin',
      threshold: 2,
      totalSigners: 4,
    })
    expect(req.threshold).toBe(2)
    expect(req.totalSigners).toBe(4)
  })

  it('throws when threshold < 1', () => {
    expect(() =>
      createSlashRequest({ targetAddress: '0x1', reason: 'x', requestedBy: 'y', threshold: 0 }),
    ).toThrow('threshold must be >= 1')
  })

  it('throws when totalSigners < threshold', () => {
    expect(() =>
      createSlashRequest({
        targetAddress: '0x1',
        reason: 'x',
        requestedBy: 'y',
        threshold: 5,
        totalSigners: 3,
      }),
    ).toThrow('totalSigners must be >= threshold')
  })
})

// ── submitVote ────────────────────────────────────────────────────────────────

describe('submitVote', () => {
  it('returns null for an unknown slash request', () => {
    expect(submitVote('nonexistent', 'voter1', 'approve')).toBeNull()
  })

  it('records an approve vote', () => {
    const req = createSlashRequest({ targetAddress: '0x1', reason: 'r', requestedBy: 'v0' })
    const result = submitVote(req.id, 'voter1', 'approve')
    expect(result).not.toBeNull()
    expect(result!.approveCount).toBe(1)
    expect(result!.rejectCount).toBe(0)
    expect(result!.status).toBe('pending')
  })

  it('records a reject vote', () => {
    const req = createSlashRequest({ targetAddress: '0x1', reason: 'r', requestedBy: 'v0' })
    const result = submitVote(req.id, 'voter1', 'reject')
    expect(result!.rejectCount).toBe(1)
    expect(result!.status).toBe('pending')
  })

  it('prevents duplicate votes from the same voter', () => {
    const req = createSlashRequest({ targetAddress: '0x1', reason: 'r', requestedBy: 'v0' })
    submitVote(req.id, 'voter1', 'approve')
    expect(() => submitVote(req.id, 'voter1', 'approve')).toThrow(
      'voter1 has already voted on this request',
    )
  })

  it('marks status approved when threshold is reached', () => {
    // threshold=3, totalSigners=5
    const req = createSlashRequest({ targetAddress: '0x1', reason: 'r', requestedBy: 'v0' })
    submitVote(req.id, 'voter1', 'approve')
    submitVote(req.id, 'voter2', 'approve')
    const result = submitVote(req.id, 'voter3', 'approve')
    expect(result!.status).toBe('approved')
    expect(result!.approveCount).toBe(3)
  })

  it('marks status rejected when threshold can no longer be reached', () => {
    // threshold=3, totalSigners=5: need 3 approves; 3 rejects makes it impossible
    const req = createSlashRequest({ targetAddress: '0x1', reason: 'r', requestedBy: 'v0' })
    submitVote(req.id, 'voter1', 'reject')
    submitVote(req.id, 'voter2', 'reject')
    const result = submitVote(req.id, 'voter3', 'reject')
    expect(result!.status).toBe('rejected')
    expect(result!.rejectCount).toBe(3)
  })

  it('stays pending when threshold is not yet reached', () => {
    const req = createSlashRequest({ targetAddress: '0x1', reason: 'r', requestedBy: 'v0' })
    submitVote(req.id, 'voter1', 'approve')
    const result = submitVote(req.id, 'voter2', 'approve')
    expect(result!.status).toBe('pending')
  })

  it('rejects further votes after request is already approved', () => {
    const req = createSlashRequest({
      targetAddress: '0x1',
      reason: 'r',
      requestedBy: 'v0',
      threshold: 2,
      totalSigners: 3,
    })
    submitVote(req.id, 'voter1', 'approve')
    submitVote(req.id, 'voter2', 'approve')
    expect(() => submitVote(req.id, 'voter3', 'approve')).toThrow('already approved')
  })

  it('rejects further votes after request is already rejected', () => {
    const req = createSlashRequest({
      targetAddress: '0x1',
      reason: 'r',
      requestedBy: 'v0',
      threshold: 2,
      totalSigners: 2,
    })
    submitVote(req.id, 'voter1', 'reject')
    // 1 reject with 0 remaining = impossible to reach threshold of 2
    expect(() => submitVote(req.id, 'voter2', 'approve')).toThrow('already rejected')
  })
})

// ── getSlashRequest ───────────────────────────────────────────────────────────

describe('getSlashRequest', () => {
  it('returns null for unknown id', () => {
    expect(getSlashRequest('unknown')).toBeNull()
  })

  it('returns the request after creation', () => {
    const req = createSlashRequest({ targetAddress: '0x2', reason: 'r', requestedBy: 'v' })
    expect(getSlashRequest(req.id)).toMatchObject({ id: req.id, targetAddress: '0x2' })
  })

  it('reflects updated status after votes', () => {
    const req = createSlashRequest({
      targetAddress: '0x2',
      reason: 'r',
      requestedBy: 'v',
      threshold: 1,
      totalSigners: 1,
    })
    submitVote(req.id, 'voter1', 'approve')
    expect(getSlashRequest(req.id)!.status).toBe('approved')
  })
})

// ── listSlashRequests ─────────────────────────────────────────────────────────

describe('listSlashRequests', () => {
  it('returns all requests when no filter is given', () => {
    createSlashRequest({ targetAddress: '0x1', reason: 'r', requestedBy: 'v' })
    createSlashRequest({ targetAddress: '0x2', reason: 'r', requestedBy: 'v' })
    expect(listSlashRequests()).toHaveLength(2)
  })

  it('filters by status', () => {
    const req = createSlashRequest({
      targetAddress: '0x1',
      reason: 'r',
      requestedBy: 'v',
      threshold: 1,
      totalSigners: 1,
    })
    createSlashRequest({ targetAddress: '0x2', reason: 'r', requestedBy: 'v' })
    submitVote(req.id, 'voter1', 'approve')

    expect(listSlashRequests('approved')).toHaveLength(1)
    expect(listSlashRequests('pending')).toHaveLength(1)
    expect(listSlashRequests('rejected')).toHaveLength(0)
  })
})
