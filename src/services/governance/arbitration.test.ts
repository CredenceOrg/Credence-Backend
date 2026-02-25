import { describe, it, expect, beforeEach } from 'vitest'
import {
  writeLog,
  readLog,
  getLogsByDispute,
  getLogsByArbiter,
  deleteLog,
  resetStore,
} from './arbitration.js'
import type { ArbitrationInput } from './types.js'

function validEntry(overrides: Partial<ArbitrationInput> = {}): ArbitrationInput {
  return {
    disputeId: 'dispute-001',
    arbiter: 'arbiter-alice',
    decision: 'uphold',
    reasoning: 'Respondent failed to meet bonded obligations per clause 4.2',
    ...overrides,
  }
}

describe('arbitration', () => {
  beforeEach(() => {
    resetStore()
  })

  // ---- writeLog ----

  describe('writeLog', () => {
    it('creates an entry with a unique id and timestamp', () => {
      const entry = writeLog(validEntry())
      expect(entry.id).toBeDefined()
      expect(entry.timestamp).toBeInstanceOf(Date)
      expect(entry.disputeId).toBe('dispute-001')
      expect(entry.arbiter).toBe('arbiter-alice')
      expect(entry.decision).toBe('uphold')
    })

    it('generates unique ids across calls', () => {
      const a = writeLog(validEntry())
      const b = writeLog(validEntry({ arbiter: 'arbiter-bob' }))
      expect(a.id).not.toBe(b.id)
    })

    it('rejects missing disputeId', () => {
      expect(() => writeLog(validEntry({ disputeId: '' }))).toThrow('disputeId is required')
    })

    it('rejects missing arbiter', () => {
      expect(() => writeLog(validEntry({ arbiter: '' }))).toThrow('arbiter is required')
    })

    it('rejects missing decision', () => {
      expect(() => writeLog(validEntry({ decision: '' }))).toThrow('decision is required')
    })

    it('rejects empty reasoning', () => {
      expect(() => writeLog(validEntry({ reasoning: '' }))).toThrow('reasoning is required')
    })

    it('rejects whitespace-only reasoning', () => {
      expect(() => writeLog(validEntry({ reasoning: '   ' }))).toThrow('reasoning is required')
    })
  })

  // ---- readLog ----

  describe('readLog', () => {
    it('retrieves a stored entry by id', () => {
      const entry = writeLog(validEntry())
      const found = readLog(entry.id)
      expect(found).toBeDefined()
      expect(found!.id).toBe(entry.id)
      expect(found!.decision).toBe('uphold')
    })

    it('returns undefined for unknown id', () => {
      expect(readLog('nonexistent')).toBeUndefined()
    })
  })

  // ---- getLogsByDispute ----

  describe('getLogsByDispute', () => {
    it('returns entries for a specific dispute, sorted by timestamp', () => {
      writeLog(validEntry({ disputeId: 'dispute-001', arbiter: 'alice' }))
      writeLog(validEntry({ disputeId: 'dispute-001', arbiter: 'bob' }))
      writeLog(validEntry({ disputeId: 'dispute-002', arbiter: 'carol' }))

      const logs = getLogsByDispute('dispute-001')
      expect(logs).toHaveLength(2)
      expect(logs[0].timestamp.getTime()).toBeLessThanOrEqual(logs[1].timestamp.getTime())
    })

    it('returns empty array when no entries match', () => {
      writeLog(validEntry())
      expect(getLogsByDispute('unknown')).toEqual([])
    })
  })

  // ---- getLogsByArbiter ----

  describe('getLogsByArbiter', () => {
    it('returns entries for a specific arbiter, sorted by timestamp', () => {
      writeLog(validEntry({ arbiter: 'alice', disputeId: 'd1' }))
      writeLog(validEntry({ arbiter: 'alice', disputeId: 'd2' }))
      writeLog(validEntry({ arbiter: 'bob', disputeId: 'd3' }))

      const logs = getLogsByArbiter('alice')
      expect(logs).toHaveLength(2)
      expect(logs.every((l) => l.arbiter === 'alice')).toBe(true)
    })

    it('returns empty array when no entries match', () => {
      writeLog(validEntry())
      expect(getLogsByArbiter('nobody')).toEqual([])
    })
  })

  // ---- deleteLog ----

  describe('deleteLog', () => {
    it('removes an existing entry', () => {
      const entry = writeLog(validEntry())
      expect(deleteLog(entry.id)).toBe(true)
      expect(readLog(entry.id)).toBeUndefined()
    })

    it('returns false for a non-existent id', () => {
      expect(deleteLog('does-not-exist')).toBe(false)
    })
  })
})
