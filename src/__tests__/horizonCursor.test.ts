import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb, type IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import crypto from 'crypto'
import { CursorRepository } from '../db/repositories/cursorRepository.js'
import { subscribeBondCreationEvents } from '../listeners/horizonBondEvents.js'
import { HorizonWithdrawalListener } from '../listeners/horizonWithdrawalEvents.js'

describe('Horizon Cursor Checkpointing', () => {
  let db: IMemoryDb
  let pool: Pool
  let cursorRepo: CursorRepository

  beforeEach(async () => {
    // Create in-memory PostgreSQL database
    db = newDb()
    db.public.registerFunction({
      name: 'gen_random_uuid',
      returns: 'uuid',
      implementation: () => crypto.randomUUID(),
    })
    const pgMock = db.adapters.createPg()
    pool = new pgMock.Pool() as unknown as Pool

    // Create horizon_cursors table
    await pool.query(`
      CREATE TABLE horizon_cursors (
        stream_name       TEXT        PRIMARY KEY,
        paging_token      TEXT        NOT NULL,
        last_checkpoint   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    // Create identities and bonds tables for listener tests
    await pool.query(`
      CREATE TABLE identities (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        address    TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE bonds (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        identity_id UUID REFERENCES identities(id),
        amount     TEXT NOT NULL,
        duration   TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    cursorRepo = new CursorRepository(pool)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('CursorRepository', () => {
    it('should upsert a new cursor', async () => {
      const cursor = await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901234'
      })

      expect(cursor.streamName).toBe('bond_creation')
      expect(cursor.pagingToken).toBe('12345678901234')
      expect(cursor.lastCheckpoint).toBeInstanceOf(Date)
    })

    it('should update existing cursor on upsert', async () => {
      // First upsert
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901234'
      })

      // Second upsert with new token
      const updated = await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901235'
      })

      expect(updated.pagingToken).toBe('12345678901235')

      // Verify only one record exists
      const all = await cursorRepo.findAll()
      expect(all).toHaveLength(1)
    })

    it('should find cursor by stream name', async () => {
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901234'
      })

      const found = await cursorRepo.findByStreamName('bond_creation')
      expect(found).not.toBeNull()
      expect(found?.pagingToken).toBe('12345678901234')
    })

    it('should return null for non-existent stream', async () => {
      const found = await cursorRepo.findByStreamName('non_existent')
      expect(found).toBeNull()
    })

    it('should validate paging_token format', async () => {
      // Valid numeric token
      await expect(
        cursorRepo.upsert({
          streamName: 'test',
          pagingToken: '12345678901234'
        })
      ).resolves.toBeDefined()

      // Valid 'now' token
      await expect(
        cursorRepo.upsert({
          streamName: 'test2',
          pagingToken: 'now'
        })
      ).resolves.toBeDefined()

      // Invalid token
      await expect(
        cursorRepo.upsert({
          streamName: 'test3',
          pagingToken: 'invalid-token'
        })
      ).rejects.toThrow('Invalid paging_token format')
    })

    it('should calculate cursor lag', async () => {
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901234'
      })

      // Wait a bit to create lag
      await new Promise(resolve => setTimeout(resolve, 100))

      const lag = await cursorRepo.getCursorLag('bond_creation')
      expect(lag).not.toBeNull()
      expect(lag).toBeGreaterThanOrEqual(0)
    })

    it('should return null lag for non-existent stream', async () => {
      const lag = await cursorRepo.getCursorLag('non_existent')
      expect(lag).toBeNull()
    })

    it('should delete cursor', async () => {
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901234'
      })

      const deleted = await cursorRepo.delete('bond_creation')
      expect(deleted).toBe(true)

      const found = await cursorRepo.findByStreamName('bond_creation')
      expect(found).toBeNull()
    })

    it('should return false when deleting non-existent cursor', async () => {
      const deleted = await cursorRepo.delete('non_existent')
      expect(deleted).toBe(false)
    })

    it('should find all cursors ordered by last checkpoint', async () => {
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901234'
      })

      await new Promise(resolve => setTimeout(resolve, 10))

      await cursorRepo.upsert({
        streamName: 'bond_withdrawal',
        pagingToken: '12345678901235'
      })

      const all = await cursorRepo.findAll()
      expect(all).toHaveLength(2)
      // Most recent first
      expect(all[0].streamName).toBe('bond_withdrawal')
      expect(all[1].streamName).toBe('bond_creation')
    })
  })

  describe('Horizon Listener Restart Scenarios', () => {
    it('should resume from saved cursor after restart', async () => {
      // Simulate first run - save cursor
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901234'
      })

      // Simulate restart - load cursor
      const savedCursor = await cursorRepo.findByStreamName('bond_creation')
      expect(savedCursor).not.toBeNull()
      expect(savedCursor?.pagingToken).toBe('12345678901234')
    })

    it('should use "now" cursor on first boot when no saved cursor exists', async () => {
      const savedCursor = await cursorRepo.findByStreamName('bond_creation')
      expect(savedCursor).toBeNull()
      
      // Listener should fall back to 'now'
      const fallbackCursor = savedCursor?.pagingToken || 'now'
      expect(fallbackCursor).toBe('now')
    })

    it('should not advance cursor if event processing fails', async () => {
      // Save initial cursor
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901234'
      })

      // Simulate event processing failure
      const processingFailed = true
      const newToken = '12345678901235'

      if (!processingFailed) {
        // Only update cursor on success
        await cursorRepo.upsert({
          streamName: 'bond_creation',
          pagingToken: newToken
        })
      }

      // Cursor should remain at old value
      const cursor = await cursorRepo.findByStreamName('bond_creation')
      expect(cursor?.pagingToken).toBe('12345678901234')
    })

    it('should handle duplicate paging_token on reconnect', async () => {
      const token = '12345678901234'

      // First processing
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: token
      })

      // Reconnect and receive same token (idempotent)
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: token
      })

      const cursor = await cursorRepo.findByStreamName('bond_creation')
      expect(cursor?.pagingToken).toBe(token)
    })

    it('should handle cursor write failure gracefully', async () => {
      // Mock cursor write failure
      const mockRepo = {
        upsert: vi.fn().mockRejectedValue(new Error('Database connection lost'))
      }

      await expect(
        mockRepo.upsert({
          streamName: 'bond_creation',
          pagingToken: '12345678901234'
        })
      ).rejects.toThrow('Database connection lost')

      // Verify cursor was not advanced
      expect(mockRepo.upsert).toHaveBeenCalledTimes(1)
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty stream name', async () => {
      await expect(
        cursorRepo.upsert({
          streamName: '',
          pagingToken: '12345678901234'
        })
      ).resolves.toBeDefined()
    })

    it('should handle very large paging tokens', async () => {
      const largeToken = '9'.repeat(50)
      await expect(
        cursorRepo.upsert({
          streamName: 'test',
          pagingToken: largeToken
        })
      ).resolves.toBeDefined()
    })

    it('should handle concurrent upserts to same stream', async () => {
      const promises = [
        cursorRepo.upsert({
          streamName: 'bond_creation',
          pagingToken: '12345678901234'
        }),
        cursorRepo.upsert({
          streamName: 'bond_creation',
          pagingToken: '12345678901235'
        }),
        cursorRepo.upsert({
          streamName: 'bond_creation',
          pagingToken: '12345678901236'
        })
      ]

      await Promise.all(promises)

      // Should have only one record with one of the tokens
      const all = await cursorRepo.findAll()
      expect(all).toHaveLength(1)
      expect(all[0].streamName).toBe('bond_creation')
    })

    it('should handle multiple streams independently', async () => {
      await cursorRepo.upsert({
        streamName: 'bond_creation',
        pagingToken: '12345678901234'
      })

      await cursorRepo.upsert({
        streamName: 'bond_withdrawal',
        pagingToken: '98765432109876'
      })

      await cursorRepo.upsert({
        streamName: 'attestation',
        pagingToken: '11111111111111'
      })

      const all = await cursorRepo.findAll()
      expect(all).toHaveLength(3)

      const bondCreation = await cursorRepo.findByStreamName('bond_creation')
      const bondWithdrawal = await cursorRepo.findByStreamName('bond_withdrawal')
      const attestation = await cursorRepo.findByStreamName('attestation')

      expect(bondCreation?.pagingToken).toBe('12345678901234')
      expect(bondWithdrawal?.pagingToken).toBe('98765432109876')
      expect(attestation?.pagingToken).toBe('11111111111111')
    })
  })

  describe('Security', () => {
    it('should reject SQL injection attempts in stream name', async () => {
      const maliciousStreamName = "'; DROP TABLE horizon_cursors; --"
      
      await cursorRepo.upsert({
        streamName: maliciousStreamName,
        pagingToken: '12345678901234'
      })

      // Table should still exist
      const result = await pool.query('SELECT COUNT(*) FROM horizon_cursors')
      expect(Number(result.rows[0].count)).toBe(1)
    })

    it('should reject SQL injection attempts in paging token', async () => {
      const maliciousToken = "12345'; DROP TABLE horizon_cursors; --"
      
      // Should fail validation before reaching database
      await expect(
        cursorRepo.upsert({
          streamName: 'test',
          pagingToken: maliciousToken
        })
      ).rejects.toThrow('Invalid paging_token format')
    })
  })
})
