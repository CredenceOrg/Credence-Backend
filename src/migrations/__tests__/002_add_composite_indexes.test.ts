import { describe, it, expect, vi, beforeEach } from 'vitest'
import { up, down } from '../002_add_composite_indexes.js'
import type { MigrationBuilder } from 'node-pg-migrate'

function createMockPgm(): MigrationBuilder {
  return {
    createIndex: vi.fn(),
    dropIndex: vi.fn(),
  } as unknown as MigrationBuilder
}

describe('002_add_composite_indexes', () => {
  let pgm: MigrationBuilder

  beforeEach(() => {
    pgm = createMockPgm()
  })

  describe('up', () => {
    it('drops all single-column FK indexes', async () => {
      await up(pgm)

      expect(pgm.dropIndex).toHaveBeenCalledWith('bonds', 'identity_address', expect.objectContaining({ name: 'bonds_identity_address_idx' }))
      expect(pgm.dropIndex).toHaveBeenCalledWith('attestations', 'subject_address', expect.objectContaining({ name: 'attestations_subject_address_idx' }))
      expect(pgm.dropIndex).toHaveBeenCalledWith('attestations', 'bond_id', expect.objectContaining({ name: 'attestations_bond_id_idx' }))
      expect(pgm.dropIndex).toHaveBeenCalledWith('slash_events', 'bond_id', expect.objectContaining({ name: 'slash_events_bond_id_idx' }))
      expect(pgm.dropIndex).toHaveBeenCalledWith('score_history', 'identity_address', expect.objectContaining({ name: 'score_history_identity_address_idx' }))
    })

    it('creates composite index on bonds(identity_address, start_time DESC, id DESC)', async () => {
      await up(pgm)

      expect(pgm.createIndex).toHaveBeenCalledWith(
        'bonds',
        ['identity_address', { name: 'start_time', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
        expect.objectContaining({ name: 'bonds_identity_start_time_idx' }),
      )
    })

    it('creates composite index on attestations(subject_address, created_at DESC, id DESC)', async () => {
      await up(pgm)

      expect(pgm.createIndex).toHaveBeenCalledWith(
        'attestations',
        ['subject_address', { name: 'created_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
        expect.objectContaining({ name: 'attestations_subject_created_idx' }),
      )
    })

    it('creates composite index on attestations(bond_id, created_at DESC, id DESC)', async () => {
      await up(pgm)

      expect(pgm.createIndex).toHaveBeenCalledWith(
        'attestations',
        ['bond_id', { name: 'created_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
        expect.objectContaining({ name: 'attestations_bond_created_idx' }),
      )
    })

    it('creates composite index on slash_events(bond_id, created_at DESC, id DESC)', async () => {
      await up(pgm)

      expect(pgm.createIndex).toHaveBeenCalledWith(
        'slash_events',
        ['bond_id', { name: 'created_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
        expect.objectContaining({ name: 'slash_events_bond_created_idx' }),
      )
    })

    it('creates composite index on score_history(identity_address, computed_at DESC, id DESC)', async () => {
      await up(pgm)

      expect(pgm.createIndex).toHaveBeenCalledWith(
        'score_history',
        ['identity_address', { name: 'computed_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
        expect.objectContaining({ name: 'score_history_identity_computed_idx' }),
      )
    })

    it('uses ifNotExists for idempotent index creation', async () => {
      await up(pgm)

      const calls = vi.mocked(pgm.createIndex).mock.calls
      for (const call of calls) {
        expect(call[2]).toMatchObject({ ifNotExists: true })
      }
    })

    it('drops indexes before creating replacements', async () => {
      await up(pgm)

      const dropOrder = vi.mocked(pgm.dropIndex).mock.invocationCallOrder
      const createOrder = vi.mocked(pgm.createIndex).mock.invocationCallOrder

      const lastDrop = Math.max(...dropOrder)
      const firstCreate = Math.min(...createOrder)

      expect(lastDrop).toBeLessThan(firstCreate)
    })
  })

  describe('down', () => {
    it('drops all composite indexes', async () => {
      await down(pgm)

      expect(pgm.dropIndex).toHaveBeenCalledWith('bonds', [], expect.objectContaining({ name: 'bonds_identity_start_time_idx' }))
      expect(pgm.dropIndex).toHaveBeenCalledWith('attestations', [], expect.objectContaining({ name: 'attestations_subject_created_idx' }))
      expect(pgm.dropIndex).toHaveBeenCalledWith('attestations', [], expect.objectContaining({ name: 'attestations_bond_created_idx' }))
      expect(pgm.dropIndex).toHaveBeenCalledWith('slash_events', [], expect.objectContaining({ name: 'slash_events_bond_created_idx' }))
      expect(pgm.dropIndex).toHaveBeenCalledWith('score_history', [], expect.objectContaining({ name: 'score_history_identity_computed_idx' }))
    })

    it('restores original single-column indexes', async () => {
      await down(pgm)

      expect(pgm.createIndex).toHaveBeenCalledWith('bonds', 'identity_address', expect.objectContaining({ name: 'bonds_identity_address_idx' }))
      expect(pgm.createIndex).toHaveBeenCalledWith('attestations', 'subject_address', expect.objectContaining({ name: 'attestations_subject_address_idx' }))
      expect(pgm.createIndex).toHaveBeenCalledWith('attestations', 'bond_id', expect.objectContaining({ name: 'attestations_bond_id_idx' }))
      expect(pgm.createIndex).toHaveBeenCalledWith('slash_events', 'bond_id', expect.objectContaining({ name: 'slash_events_bond_id_idx' }))
      expect(pgm.createIndex).toHaveBeenCalledWith('score_history', 'identity_address', expect.objectContaining({ name: 'score_history_identity_address_idx' }))
    })
  })
})
