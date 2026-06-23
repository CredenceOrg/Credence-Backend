import { describe, it, expect } from 'vitest'
import {
  isValidTransition, tryTransition, VALID_TRANSITIONS, DISPUTE_STATES } from './disputeStateMachine.js'
import type { DisputeStatus } from './types.js'

describe('disputeStateMachine', () => {
  describe('valid transitions', () => {
    it('allows pending → under_review', () => {
      expect(isValidTransition('pending', 'under_review')).toBe(true)
    })

    it('allows pending → resolved', () => {
      expect(isValidTransition('pending', 'resolved')).toBe(true)
    })

    it('allows pending → dismissed', () => {
      expect(isValidTransition('pending', 'dismissed')).toBe(true)
    })

    it('allows pending → expired', () => {
      expect(isValidTransition('pending', 'expired')).toBe(true)
    })

    it('allows under_review → resolved', () => {
      expect(isValidTransition('under_review', 'resolved')).toBe(true)
    })

    it('allows under_review → dismissed', () => {
      expect(isValidTransition('under_review', 'dismissed')).toBe(true)
    })

    it('allows under_review → expired', () => {
      expect(isValidTransition('under_review', 'expired')).toBe(true)
    })
  })

  describe('invalid transitions', () => {
    it('disallows resolved → pending', () => {
      expect(isValidTransition('resolved', 'pending')).toBe(false)
    })

    it('disallows resolved → under_review', () => {
      expect(isValidTransition('resolved', 'under_review')).toBe(false)
    })

    it('disallows resolved → dismissed', () => {
      expect(isValidTransition('resolved', 'dismissed')).toBe(false)
    })

    it('disallows resolved → expired', () => {
      expect(isValidTransition('resolved', 'expired')).toBe(false)
    })

    it('disallows dismissed → pending', () => {
      expect(isValidTransition('dismissed', 'pending')).toBe(false)
    })

    it('disallows expired → pending', () => {
      expect(isValidTransition('expired', 'pending')).toBe(false)
    })

    it('disallows under_review → under_review', () => {
      expect(isValidTransition('under_review', 'under_review')).toBe(false)
    })
  })

  describe('tryTransition', () => {
    it('returns success for valid transition', () => {
      const result = tryTransition('pending', 'under_review')
      expect(result.success).toBe(true)
      expect(result.from).toBe('pending')
      expect(result.to).toBe('under_review')
      expect(result.error).toBeUndefined()
    })

    it('returns error for invalid transition', () => {
      const result = tryTransition('resolved', 'pending')
      expect(result.success).toBe(false)
      expect(result.from).toBe('resolved')
      expect(result.to).toBe('pending')
      expect(result.error).toBeDefined()
      expect(result.error).toContain('Invalid transition')
    })
  })

  describe('VALID_TRANSITIONS', () => {
    it('covers all valid state transitions', () => {
      for (const transition of VALID_TRANSITIONS) {
        expect(isValidTransition(transition.from, transition.to)).toBe(true)
      }
    })
  })

  describe('DISPUTE_STATES', () => {
    it('includes all known dispute states', () => {
      const expected: DisputeStatus[] = ['pending', 'under_review', 'resolved', 'dismissed', 'expired']
      expect(DISPUTE_STATES).toEqual(expected)
    })
  })
})
