import { describe, it, expect, beforeEach } from 'vitest'
import {
  castVote,
  getVotes,
  countVotes,
  hasReachedThreshold,
  getVoteSummary,
  resetStore,
} from './votes.js'

const PROPOSAL = 'prop-001'

describe('votes', () => {
  beforeEach(() => {
    resetStore()
  })

  // ---- casting ----

  describe('castVote', () => {
    it('records a valid vote', () => {
      const v = castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 10, inFavor: true })
      expect(v.proposalId).toBe(PROPOSAL)
      expect(v.voter).toBe('alice')
      expect(v.weight).toBe(10)
      expect(v.inFavor).toBe(true)
      expect(v.castAt).toBeInstanceOf(Date)
    })

    it('prevents duplicate votes from the same voter', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 5, inFavor: true })
      expect(() =>
        castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 5, inFavor: false }),
      ).toThrow('already voted')
    })

    it('allows the same voter on different proposals', () => {
      castVote({ proposalId: 'p1', voter: 'alice', weight: 5, inFavor: true })
      const v = castVote({ proposalId: 'p2', voter: 'alice', weight: 5, inFavor: false })
      expect(v.proposalId).toBe('p2')
    })

    it('rejects missing proposalId', () => {
      expect(() =>
        castVote({ proposalId: '', voter: 'alice', weight: 5, inFavor: true }),
      ).toThrow('proposalId is required')
    })

    it('rejects missing voter', () => {
      expect(() =>
        castVote({ proposalId: PROPOSAL, voter: '', weight: 5, inFavor: true }),
      ).toThrow('voter is required')
    })

    it('rejects zero weight', () => {
      expect(() =>
        castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 0, inFavor: true }),
      ).toThrow('weight must be a positive number')
    })

    it('rejects negative weight', () => {
      expect(() =>
        castVote({ proposalId: PROPOSAL, voter: 'alice', weight: -3, inFavor: true }),
      ).toThrow('weight must be a positive number')
    })

    it('rejects non-boolean inFavor', () => {
      expect(() =>
        // @ts-expect-error intentionally passing wrong type
        castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 5, inFavor: 'yes' }),
      ).toThrow('inFavor must be a boolean')
    })
  })

  // ---- retrieval ----

  describe('getVotes', () => {
    it('returns empty array for unknown proposal', () => {
      expect(getVotes('nonexistent')).toEqual([])
    })

    it('returns all votes for a proposal', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 10, inFavor: true })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 5, inFavor: false })
      expect(getVotes(PROPOSAL)).toHaveLength(2)
    })
  })

  // ---- counting ----

  describe('countVotes', () => {
    it('returns zeros for a proposal with no votes', () => {
      expect(countVotes('empty')).toEqual({ totalFor: 0, totalAgainst: 0 })
    })

    it('sums weights per side correctly', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 10, inFavor: true })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 3, inFavor: false })
      castVote({ proposalId: PROPOSAL, voter: 'carol', weight: 7, inFavor: true })
      const { totalFor, totalAgainst } = countVotes(PROPOSAL)
      expect(totalFor).toBe(17)
      expect(totalAgainst).toBe(3)
    })

    it('handles all votes in favor', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 5, inFavor: true })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 5, inFavor: true })
      const { totalFor, totalAgainst } = countVotes(PROPOSAL)
      expect(totalFor).toBe(10)
      expect(totalAgainst).toBe(0)
    })

    it('handles all votes against', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 4, inFavor: false })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 6, inFavor: false })
      const { totalFor, totalAgainst } = countVotes(PROPOSAL)
      expect(totalFor).toBe(0)
      expect(totalAgainst).toBe(10)
    })
  })

  // ---- threshold ----

  describe('hasReachedThreshold', () => {
    it('returns false when there are no votes', () => {
      expect(hasReachedThreshold('empty')).toBe(false)
    })

    it('returns true when for-weight exceeds default 66%', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 70, inFavor: true })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 30, inFavor: false })
      expect(hasReachedThreshold(PROPOSAL)).toBe(true)
    })

    it('returns false when for-weight is below default 66%', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 60, inFavor: true })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 40, inFavor: false })
      expect(hasReachedThreshold(PROPOSAL)).toBe(false)
    })

    it('accepts a custom threshold', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 51, inFavor: true })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 49, inFavor: false })
      expect(hasReachedThreshold(PROPOSAL, 0.5)).toBe(true)
      expect(hasReachedThreshold(PROPOSAL, 0.55)).toBe(false)
    })

    it('treats exactly-at-threshold as reached', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 2, inFavor: true })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 1, inFavor: false })
      // 2/3 ≈ 0.6667 — above the 0.66 default
      expect(hasReachedThreshold(PROPOSAL)).toBe(true)
    })

    it('throws for invalid threshold values', () => {
      expect(() => hasReachedThreshold(PROPOSAL, 0)).toThrow('Threshold must be between')
      expect(() => hasReachedThreshold(PROPOSAL, -0.5)).toThrow('Threshold must be between')
      expect(() => hasReachedThreshold(PROPOSAL, 1.1)).toThrow('Threshold must be between')
    })

    it('allows threshold of exactly 1', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 10, inFavor: true })
      expect(hasReachedThreshold(PROPOSAL, 1)).toBe(true)
    })
  })

  // ---- summary ----

  describe('getVoteSummary', () => {
    it('returns a complete summary', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 10, inFavor: true })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 3, inFavor: false })
      castVote({ proposalId: PROPOSAL, voter: 'carol', weight: 7, inFavor: true })

      const summary = getVoteSummary(PROPOSAL)
      expect(summary.proposalId).toBe(PROPOSAL)
      expect(summary.totalFor).toBe(17)
      expect(summary.totalAgainst).toBe(3)
      expect(summary.voterCount).toBe(3)
      expect(summary.reachedThreshold).toBe(true) // 17/20 = 85%
    })

    it('returns a summary for a proposal with no votes', () => {
      const summary = getVoteSummary('ghost')
      expect(summary.voterCount).toBe(0)
      expect(summary.totalFor).toBe(0)
      expect(summary.totalAgainst).toBe(0)
      expect(summary.reachedThreshold).toBe(false)
    })

    it('respects custom threshold in summary', () => {
      castVote({ proposalId: PROPOSAL, voter: 'alice', weight: 55, inFavor: true })
      castVote({ proposalId: PROPOSAL, voter: 'bob', weight: 45, inFavor: false })

      expect(getVoteSummary(PROPOSAL, 0.5).reachedThreshold).toBe(true)
      expect(getVoteSummary(PROPOSAL, 0.6).reachedThreshold).toBe(false)
    })
  })
})
