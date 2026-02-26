import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  submitDispute,
  getDispute,
  isExpired,
  resolveDispute,
  dismissDispute,
  markUnderReview,
  validateDisputeInput,
  resetStore,
} from './disputes.js'
import type { DisputeInput } from './types.js'

// Two valid Stellar addresses (56 chars, starting with G, base32 alphabet)
const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2'
const BOB = 'GABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB3'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function validInput(overrides: Partial<DisputeInput> = {}): DisputeInput {
  return {
    filedBy: ALICE,
    respondent: BOB,
    reason: 'Failure to deliver contracted services within agreed timeline',
    evidence: ['tx:abc123'],
    deadlineMs: 7 * DAY,
    ...overrides,
  }
}

describe('disputes', () => {
  beforeEach(() => {
    resetStore()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ---- validation ----

  describe('validateDisputeInput', () => {
    it('returns no errors for valid input', () => {
      expect(validateDisputeInput(validInput())).toEqual([])
    })

    it('rejects missing filedBy', () => {
      const errors = validateDisputeInput(validInput({ filedBy: '' }))
      expect(errors).toContain('filedBy is required')
    })

    it('rejects invalid filedBy address format', () => {
      const errors = validateDisputeInput(validInput({ filedBy: 'not-a-stellar-addr' }))
      expect(errors).toContain('filedBy must be a valid Stellar address')
    })

    it('rejects missing respondent', () => {
      const errors = validateDisputeInput(validInput({ respondent: '' }))
      expect(errors).toContain('respondent is required')
    })

    it('rejects invalid respondent address format', () => {
      const errors = validateDisputeInput(validInput({ respondent: '0xabc' }))
      expect(errors).toContain('respondent must be a valid Stellar address')
    })

    it('rejects same filedBy and respondent', () => {
      const errors = validateDisputeInput(validInput({ respondent: ALICE }))
      expect(errors).toContain('filedBy and respondent must differ')
    })

    it('rejects short reason', () => {
      const errors = validateDisputeInput(validInput({ reason: 'short' }))
      expect(errors).toContain('reason must be at least 10 characters')
    })

    it('rejects empty reason', () => {
      const errors = validateDisputeInput(validInput({ reason: '' }))
      expect(errors).toContain('reason is required')
    })

    it('rejects missing evidence', () => {
      const errors = validateDisputeInput(validInput({ evidence: [] }))
      expect(errors).toContain('at least one piece of evidence is required')
    })

    it('rejects deadline below minimum', () => {
      const errors = validateDisputeInput(validInput({ deadlineMs: 1000 }))
      expect(errors.some((e) => e.includes('at least'))).toBe(true)
    })

    it('rejects deadline above maximum', () => {
      const errors = validateDisputeInput(validInput({ deadlineMs: 31 * DAY }))
      expect(errors.some((e) => e.includes('at most'))).toBe(true)
    })

    it('accumulates multiple errors', () => {
      const errors = validateDisputeInput({
        filedBy: '',
        respondent: '',
        reason: '',
        evidence: [],
        deadlineMs: -1,
      })
      expect(errors.length).toBeGreaterThanOrEqual(4)
    })
  })

  // ---- submission ----

  describe('submitDispute', () => {
    it('creates a dispute with correct defaults', () => {
      const d = submitDispute(validInput())
      expect(d.id).toBeDefined()
      expect(d.status).toBe('pending')
      expect(d.resolution).toBeNull()
      expect(d.filedBy).toBe(ALICE)
      expect(d.respondent).toBe(BOB)
      expect(d.evidence).toEqual(['tx:abc123'])
      expect(d.createdAt).toBeInstanceOf(Date)
      expect(d.deadline.getTime()).toBeGreaterThan(d.createdAt.getTime())
    })

    it('stores the dispute for later retrieval', () => {
      const d = submitDispute(validInput())
      expect(getDispute(d.id)).toEqual(d)
    })

    it('throws on invalid input', () => {
      expect(() => submitDispute(validInput({ filedBy: '' }))).toThrow('Invalid dispute')
    })

    it('copies evidence array (no shared reference)', () => {
      const evidence = ['tx:abc123']
      const d = submitDispute(validInput({ evidence }))
      evidence.push('tx:def456')
      expect(d.evidence).toEqual(['tx:abc123'])
    })
  })

  // ---- retrieval ----

  describe('getDispute', () => {
    it('returns undefined for unknown id', () => {
      expect(getDispute('nonexistent')).toBeUndefined()
    })
  })

  // ---- expiry ----

  describe('isExpired', () => {
    it('returns false when deadline is in the future', () => {
      const d = submitDispute(validInput())
      expect(isExpired(d)).toBe(false)
    })

    it('returns true when deadline has passed', () => {
      const d = submitDispute(validInput({ deadlineMs: HOUR }))
      // Manually push the deadline into the past
      d.deadline = new Date(Date.now() - 1000)
      expect(isExpired(d)).toBe(true)
    })
  })

  // ---- resolution ----

  describe('resolveDispute', () => {
    it('resolves a pending dispute', () => {
      const d = submitDispute(validInput())
      const resolved = resolveDispute(d.id, 'Both parties agreed to settlement')
      expect(resolved.status).toBe('resolved')
      expect(resolved.resolution).toBe('Both parties agreed to settlement')
    })

    it('resolves an under_review dispute', () => {
      const d = submitDispute(validInput())
      markUnderReview(d.id)
      const resolved = resolveDispute(d.id, 'Arbiter ruled in favor of filer')
      expect(resolved.status).toBe('resolved')
    })

    it('throws when dispute not found', () => {
      expect(() => resolveDispute('missing', 'text')).toThrow('not found')
    })

    it('throws when already resolved', () => {
      const d = submitDispute(validInput())
      resolveDispute(d.id, 'done')
      expect(() => resolveDispute(d.id, 'again')).toThrow('already resolved')
    })

    it('throws when dispute was dismissed', () => {
      const d = submitDispute(validInput())
      dismissDispute(d.id, 'Frivolous claim')
      expect(() => resolveDispute(d.id, 'nah')).toThrow('dismissed')
    })

    it('throws when dispute is expired', () => {
      const d = submitDispute(validInput({ deadlineMs: HOUR }))
      d.deadline = new Date(Date.now() - 1000) // force expired
      expect(() => resolveDispute(d.id, 'too late')).toThrow('expired')
      expect(d.status).toBe('expired')
    })

    it('throws when resolution text is empty', () => {
      const d = submitDispute(validInput())
      expect(() => resolveDispute(d.id, '')).toThrow('Resolution text is required')
    })

    it('throws when resolution text is whitespace only', () => {
      const d = submitDispute(validInput())
      expect(() => resolveDispute(d.id, '   ')).toThrow('Resolution text is required')
    })
  })

  // ---- dismissal ----

  describe('dismissDispute', () => {
    it('dismisses a pending dispute', () => {
      const d = submitDispute(validInput())
      const dismissed = dismissDispute(d.id, 'Insufficient evidence')
      expect(dismissed.status).toBe('dismissed')
      expect(dismissed.resolution).toBe('Insufficient evidence')
    })

    it('throws when dispute not found', () => {
      expect(() => dismissDispute('x', 'reason')).toThrow('not found')
    })

    it('throws when already resolved', () => {
      const d = submitDispute(validInput())
      resolveDispute(d.id, 'done')
      expect(() => dismissDispute(d.id, 'reason')).toThrow('resolved')
    })

    it('throws when already dismissed', () => {
      const d = submitDispute(validInput())
      dismissDispute(d.id, 'reason')
      expect(() => dismissDispute(d.id, 'again')).toThrow('already dismissed')
    })

    it('throws when reason is empty', () => {
      const d = submitDispute(validInput())
      expect(() => dismissDispute(d.id, '')).toThrow('Dismiss reason is required')
    })
  })

  // ---- review transition ----

  describe('markUnderReview', () => {
    it('transitions pending → under_review', () => {
      const d = submitDispute(validInput())
      const updated = markUnderReview(d.id)
      expect(updated.status).toBe('under_review')
    })

    it('throws when not in pending state', () => {
      const d = submitDispute(validInput())
      markUnderReview(d.id)
      expect(() => markUnderReview(d.id)).toThrow('Cannot review dispute')
    })

    it('throws when dispute not found', () => {
      expect(() => markUnderReview('x')).toThrow('not found')
    })
  })
})
