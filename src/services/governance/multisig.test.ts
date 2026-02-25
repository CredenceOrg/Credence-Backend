import { describe, it, expect, beforeEach } from 'vitest'
import {
  createProposal,
  getProposal,
  addSignature,
  removeSignature,
  executeIfReady,
  cancelProposal,
  getStatus,
  resetStore,
} from './multisig.js'
import type { MultisigInput } from './types.js'

const HOUR = 60 * 60 * 1000

function validInput(overrides: Partial<MultisigInput> = {}): MultisigInput {
  return {
    signers: ['alice', 'bob', 'carol'],
    requiredSignatures: 2,
    action: 'slash_bond',
    ttlMs: 24 * HOUR,
    ...overrides,
  }
}

describe('multisig', () => {
  beforeEach(() => {
    resetStore()
  })

  // ---- createProposal ----

  describe('createProposal', () => {
    it('creates a proposal with correct initial state', () => {
      const p = createProposal(validInput())
      expect(p.id).toBeDefined()
      expect(p.status).toBe('pending')
      expect(p.signatures.size).toBe(0)
      expect(p.signers).toEqual(['alice', 'bob', 'carol'])
      expect(p.requiredSignatures).toBe(2)
      expect(p.action).toBe('slash_bond')
      expect(p.expiresAt.getTime()).toBeGreaterThan(p.createdAt.getTime())
    })

    it('copies the signers array (no shared reference)', () => {
      const signers = ['alice', 'bob']
      const p = createProposal(validInput({ signers }))
      signers.push('dave')
      expect(p.signers).toEqual(['alice', 'bob'])
    })

    it('rejects fewer than 2 signers', () => {
      expect(() => createProposal(validInput({ signers: ['alice'] }))).toThrow(
        'At least 2 signers',
      )
    })

    it('rejects more than 20 signers', () => {
      const signers = Array.from({ length: 21 }, (_, i) => `signer-${i}`)
      expect(() => createProposal(validInput({ signers }))).toThrow('Cannot exceed 20')
    })

    it('rejects duplicate signers', () => {
      expect(() =>
        createProposal(validInput({ signers: ['alice', 'alice', 'bob'] })),
      ).toThrow('Duplicate signers')
    })

    it('rejects requiredSignatures of 0', () => {
      expect(() => createProposal(validInput({ requiredSignatures: 0 }))).toThrow(
        'requiredSignatures must be between',
      )
    })

    it('rejects requiredSignatures exceeding signer count', () => {
      expect(() => createProposal(validInput({ requiredSignatures: 5 }))).toThrow(
        'requiredSignatures must be between',
      )
    })

    it('rejects missing action', () => {
      expect(() => createProposal(validInput({ action: '' }))).toThrow('action is required')
    })

    it('rejects ttl below minimum', () => {
      expect(() => createProposal(validInput({ ttlMs: 1000 }))).toThrow('ttlMs must be at least')
    })
  })

  // ---- retrieval ----

  describe('getProposal', () => {
    it('retrieves a stored proposal', () => {
      const p = createProposal(validInput())
      expect(getProposal(p.id)).toBeDefined()
      expect(getProposal(p.id)!.id).toBe(p.id)
    })

    it('returns undefined for unknown id', () => {
      expect(getProposal('ghost')).toBeUndefined()
    })
  })

  // ---- signatures ----

  describe('addSignature', () => {
    it('adds a valid signer', () => {
      const p = createProposal(validInput())
      addSignature(p.id, 'alice')
      expect(p.signatures.has('alice')).toBe(true)
      expect(p.signatures.size).toBe(1)
    })

    it('accumulates multiple signatures', () => {
      const p = createProposal(validInput())
      addSignature(p.id, 'alice')
      addSignature(p.id, 'bob')
      expect(p.signatures.size).toBe(2)
    })

    it('rejects an unauthorized signer', () => {
      const p = createProposal(validInput())
      expect(() => addSignature(p.id, 'eve')).toThrow('not an authorized signer')
    })

    it('rejects duplicate signature from the same signer', () => {
      const p = createProposal(validInput())
      addSignature(p.id, 'alice')
      expect(() => addSignature(p.id, 'alice')).toThrow('already signed')
    })

    it('throws for non-existent proposal', () => {
      expect(() => addSignature('nope', 'alice')).toThrow('not found')
    })

    it('throws when proposal is not pending', () => {
      const p = createProposal(validInput())
      addSignature(p.id, 'alice')
      addSignature(p.id, 'bob')
      executeIfReady(p.id)
      expect(() => addSignature(p.id, 'carol')).toThrow('Cannot sign a proposal')
    })

    it('auto-expires and throws when signing past expiry', () => {
      const p = createProposal(validInput({ ttlMs: HOUR }))
      p.expiresAt = new Date(Date.now() - 1000) // force expired
      expect(() => addSignature(p.id, 'alice')).toThrow('expired')
      expect(p.status).toBe('expired')
    })
  })

  describe('removeSignature', () => {
    it('removes a signature', () => {
      const p = createProposal(validInput())
      addSignature(p.id, 'alice')
      removeSignature(p.id, 'alice')
      expect(p.signatures.size).toBe(0)
    })

    it('throws when signer has not signed', () => {
      const p = createProposal(validInput())
      expect(() => removeSignature(p.id, 'alice')).toThrow('has not signed')
    })

    it('throws for non-existent proposal', () => {
      expect(() => removeSignature('nope', 'alice')).toThrow('not found')
    })

    it('throws when proposal is not pending', () => {
      const p = createProposal(validInput())
      cancelProposal(p.id)
      expect(() => removeSignature(p.id, 'alice')).toThrow('Cannot modify')
    })
  })

  // ---- execution ----

  describe('executeIfReady', () => {
    it('executes when enough signatures are present', () => {
      const p = createProposal(validInput({ requiredSignatures: 2 }))
      addSignature(p.id, 'alice')
      addSignature(p.id, 'bob')
      const executed = executeIfReady(p.id)
      expect(executed.status).toBe('executed')
    })

    it('throws when not enough signatures', () => {
      const p = createProposal(validInput({ requiredSignatures: 2 }))
      addSignature(p.id, 'alice')
      expect(() => executeIfReady(p.id)).toThrow('Not enough signatures: 1/2')
    })

    it('throws for non-existent proposal', () => {
      expect(() => executeIfReady('does-not-exist')).toThrow('not found')
    })

    it('throws when not in pending state', () => {
      const p = createProposal(validInput())
      cancelProposal(p.id)
      expect(() => executeIfReady(p.id)).toThrow('Cannot execute')
    })

    it('auto-expires and throws on execution past expiry', () => {
      const p = createProposal(validInput({ ttlMs: HOUR }))
      addSignature(p.id, 'alice')
      addSignature(p.id, 'bob')
      p.expiresAt = new Date(Date.now() - 1000) // force expired
      expect(() => executeIfReady(p.id)).toThrow('expired')
      expect(p.status).toBe('expired')
    })
  })

  // ---- cancellation ----

  describe('cancelProposal', () => {
    it('cancels a pending proposal', () => {
      const p = createProposal(validInput())
      const cancelled = cancelProposal(p.id)
      expect(cancelled.status).toBe('cancelled')
    })

    it('cancels an expired proposal', () => {
      const p = createProposal(validInput({ ttlMs: HOUR }))
      p.expiresAt = new Date(Date.now() - 1000)
      // status is still 'pending' (lazy expiry), cancel should work
      const cancelled = cancelProposal(p.id)
      expect(cancelled.status).toBe('cancelled')
    })

    it('throws when already executed', () => {
      const p = createProposal(validInput())
      addSignature(p.id, 'alice')
      addSignature(p.id, 'bob')
      executeIfReady(p.id)
      expect(() => cancelProposal(p.id)).toThrow('Cannot cancel an executed')
    })

    it('throws when already cancelled', () => {
      const p = createProposal(validInput())
      cancelProposal(p.id)
      expect(() => cancelProposal(p.id)).toThrow('already cancelled')
    })

    it('throws for non-existent proposal', () => {
      expect(() => cancelProposal('missing')).toThrow('not found')
    })
  })

  // ---- status ----

  describe('getStatus', () => {
    it('returns pending for a new proposal', () => {
      const p = createProposal(validInput())
      expect(getStatus(p.id)).toBe('pending')
    })

    it('returns executed after execution', () => {
      const p = createProposal(validInput())
      addSignature(p.id, 'alice')
      addSignature(p.id, 'bob')
      executeIfReady(p.id)
      expect(getStatus(p.id)).toBe('executed')
    })

    it('returns cancelled after cancellation', () => {
      const p = createProposal(validInput())
      cancelProposal(p.id)
      expect(getStatus(p.id)).toBe('cancelled')
    })

    it('lazily transitions to expired when deadline passed', () => {
      const p = createProposal(validInput({ ttlMs: HOUR }))
      p.expiresAt = new Date(Date.now() - 1000)
      expect(getStatus(p.id)).toBe('expired')
    })

    it('throws for non-existent proposal', () => {
      expect(() => getStatus('fake')).toThrow('not found')
    })
  })

  // ---- full lifecycle (integration-ish) ----

  describe('lifecycle', () => {
    it('pending → signed → executed', () => {
      const p = createProposal(validInput({ requiredSignatures: 3 }))
      expect(getStatus(p.id)).toBe('pending')

      addSignature(p.id, 'alice')
      addSignature(p.id, 'bob')
      expect(() => executeIfReady(p.id)).toThrow('Not enough signatures')

      addSignature(p.id, 'carol')
      executeIfReady(p.id)
      expect(getStatus(p.id)).toBe('executed')
    })

    it('pending → signed → remove sig → add sig → execute', () => {
      const p = createProposal(validInput({ requiredSignatures: 2 }))
      addSignature(p.id, 'alice')
      addSignature(p.id, 'bob')
      removeSignature(p.id, 'bob')

      expect(() => executeIfReady(p.id)).toThrow('Not enough signatures')

      addSignature(p.id, 'carol')
      executeIfReady(p.id)
      expect(getStatus(p.id)).toBe('executed')
    })

    it('pending → cancelled (blocks further signatures)', () => {
      const p = createProposal(validInput())
      addSignature(p.id, 'alice')
      cancelProposal(p.id)

      expect(() => addSignature(p.id, 'bob')).toThrow('Cannot sign')
      expect(() => executeIfReady(p.id)).toThrow('Cannot execute')
    })
  })
})
