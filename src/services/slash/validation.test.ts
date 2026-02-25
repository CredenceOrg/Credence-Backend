import { describe, it, expect } from 'vitest'
import {
  validateCreateSlashRequest,
  isValidStellarAddress,
  isValidStatusTransition,
  getStatusTransitionError,
} from './validation.js'
import { SlashStatus } from './types.js'
import type { CreateSlashRequestInput } from './types.js'

describe('Slash Validation', () => {
  const VALID_ADDRESS_1 = 'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
  const VALID_ADDRESS_2 = 'GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'

  describe('isValidStellarAddress', () => {
    it('should accept valid Stellar address', () => {
      expect(isValidStellarAddress(VALID_ADDRESS_1)).toBe(true)
      expect(isValidStellarAddress(VALID_ADDRESS_2)).toBe(true)
    })

    it('should reject invalid addresses', () => {
      expect(isValidStellarAddress('INVALID')).toBe(false)
      expect(isValidStellarAddress('G123')).toBe(false)
      expect(isValidStellarAddress('AABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ')).toBe(false)
      expect(isValidStellarAddress('')).toBe(false)
    })
  })

  describe('validateCreateSlashRequest', () => {
    const validInput: CreateSlashRequestInput = {
      targetAddress: VALID_ADDRESS_1,
      amount: '100.5',
      reason: 'Malicious behavior detected with sufficient evidence',
      evidenceRef: 'https://evidence.example.com/case-123',
      submittedBy: VALID_ADDRESS_2,
    }

    it('should pass validation for valid input', () => {
      const errors = validateCreateSlashRequest(validInput)
      expect(errors).toHaveLength(0)
    })

    it('should reject missing target address', () => {
      const input = { ...validInput, targetAddress: '' }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'targetAddress')).toBe(true)
    })

    it('should reject invalid target address format', () => {
      const input = { ...validInput, targetAddress: 'INVALID' }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'targetAddress')).toBe(true)
    })

    it('should reject missing submitter address', () => {
      const input = { ...validInput, submittedBy: '' }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'submittedBy')).toBe(true)
    })

    it('should reject self-slash attempt', () => {
      const input = { ...validInput, targetAddress: VALID_ADDRESS_2, submittedBy: VALID_ADDRESS_2 }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'targetAddress' && e.message.includes('yourself'))).toBe(true)
    })

    it('should reject missing amount', () => {
      const input = { ...validInput, amount: '' }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'amount')).toBe(true)
    })

    it('should reject invalid amount format', () => {
      const input = { ...validInput, amount: 'not-a-number' }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'amount')).toBe(true)
    })

    it('should reject zero or negative amount', () => {
      const input1 = { ...validInput, amount: '0' }
      const errors1 = validateCreateSlashRequest(input1)
      expect(errors1.some((e) => e.field === 'amount')).toBe(true)

      const input2 = { ...validInput, amount: '-10' }
      const errors2 = validateCreateSlashRequest(input2)
      expect(errors2.some((e) => e.field === 'amount')).toBe(true)

      const input3 = { ...validInput, amount: '0.00000001' }
      const errors3 = validateCreateSlashRequest(input3)
      expect(errors3.some((e) => e.field === 'amount')).toBe(true)
    })

    it('should reject amount exceeding maximum', () => {
      const input = { ...validInput, amount: '2000000000' }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'amount')).toBe(true)
    })

    it('should reject missing reason', () => {
      const input = { ...validInput, reason: '' }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'reason')).toBe(true)
    })

    it('should reject reason that is too short', () => {
      const input = { ...validInput, reason: 'Too short' }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'reason')).toBe(true)
    })

    it('should reject reason that is too long', () => {
      const input = { ...validInput, reason: 'x'.repeat(6000) }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'reason')).toBe(true)
    })

    it('should reject missing evidence reference', () => {
      const input = { ...validInput, evidenceRef: '' }
      const errors = validateCreateSlashRequest(input)
      expect(errors.some((e) => e.field === 'evidenceRef')).toBe(true)
    })

    it('should accept valid decimal amounts', () => {
      const inputs = [
        { ...validInput, amount: '0.0000002' },
        { ...validInput, amount: '100' },
        { ...validInput, amount: '999999.123456' },
      ]

      inputs.forEach((input) => {
        const errors = validateCreateSlashRequest(input)
        expect(errors.filter((e) => e.field === 'amount')).toHaveLength(0)
      })
    })
  })

  describe('isValidStatusTransition', () => {
    it('should allow pending -> approved', () => {
      expect(isValidStatusTransition(SlashStatus.PENDING, SlashStatus.APPROVED)).toBe(true)
    })

    it('should allow pending -> rejected', () => {
      expect(isValidStatusTransition(SlashStatus.PENDING, SlashStatus.REJECTED)).toBe(true)
    })

    it('should allow approved -> executed', () => {
      expect(isValidStatusTransition(SlashStatus.APPROVED, SlashStatus.EXECUTED)).toBe(true)
    })

    it('should not allow pending -> executed', () => {
      expect(isValidStatusTransition(SlashStatus.PENDING, SlashStatus.EXECUTED)).toBe(false)
    })

    it('should not allow rejected -> any transition', () => {
      expect(isValidStatusTransition(SlashStatus.REJECTED, SlashStatus.APPROVED)).toBe(false)
      expect(isValidStatusTransition(SlashStatus.REJECTED, SlashStatus.EXECUTED)).toBe(false)
    })

    it('should not allow executed -> any transition', () => {
      expect(isValidStatusTransition(SlashStatus.EXECUTED, SlashStatus.APPROVED)).toBe(false)
      expect(isValidStatusTransition(SlashStatus.EXECUTED, SlashStatus.REJECTED)).toBe(false)
    })

    it('should not allow approved -> rejected', () => {
      expect(isValidStatusTransition(SlashStatus.APPROVED, SlashStatus.REJECTED)).toBe(false)
    })
  })

  describe('getStatusTransitionError', () => {
    it('should return error for same status', () => {
      const error = getStatusTransitionError(SlashStatus.PENDING, SlashStatus.PENDING)
      expect(error).toContain('already')
    })

    it('should return error for invalid pending transition', () => {
      const error = getStatusTransitionError(SlashStatus.PENDING, SlashStatus.EXECUTED)
      expect(error).toContain('approve or reject')
    })

    it('should return error for rejected request', () => {
      const error = getStatusTransitionError(SlashStatus.REJECTED, SlashStatus.APPROVED)
      expect(error).toContain('rejected')
    })

    it('should return error for executed request', () => {
      const error = getStatusTransitionError(SlashStatus.EXECUTED, SlashStatus.APPROVED)
      expect(error).toContain('executed')
    })
  })
})
