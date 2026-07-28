import { describe, it, expect, vi, beforeEach } from 'vitest'
import { up, down } from './006_add_tx_indexes.js'
import type { MigrationBuilder } from 'node-pg-migrate'

function createMockPgm(): MigrationBuilder {
  return {
    sql: vi.fn(),
  } as unknown as MigrationBuilder
}

const sqlOf = (pgm: MigrationBuilder): string[] =>
  vi.mocked(pgm.sql).mock.calls.map((call) => call[0] as string)

describe('006_add_tx_indexes', () => {
  let pgm: MigrationBuilder

  beforeEach(() => {
    pgm = createMockPgm()
  })

  describe('up', () => {
    it('creates covering index on settlements(bond_id, settled_at DESC, id DESC)', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_settlements_bond_settled_at'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
      expect(stmt).toMatch(/ON settlements \(bond_id, settled_at DESC, id DESC\)/)
    })

    it('creates index on settlements(transaction_hash)', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_settlements_transaction_hash'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
      expect(stmt).toMatch(/ON settlements \(transaction_hash\)/)
    })

    it('creates covering index on bonds(identity_id, created_at DESC)', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_bonds_identity_created_at'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
      expect(stmt).toMatch(/ON bonds \(identity_id, created_at DESC\)/)
    })

    it('creates partial index on bonds(bond_end) WHERE active = TRUE', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_bonds_active_bond_end'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
      expect(stmt).toMatch(/ON bonds \(bond_end\)/)
      expect(stmt).toMatch(/WHERE active = TRUE/)
    })

    it('issues exactly four CREATE INDEX statements', async () => {
      await up(pgm)
      const stmts = sqlOf(pgm)
      const creates = stmts.filter((s) => /CREATE INDEX/.test(s))
      expect(creates).toHaveLength(4)
    })

    it('every CREATE INDEX uses CONCURRENTLY and IF NOT EXISTS for safety', async () => {
      await up(pgm)
      const stmts = sqlOf(pgm)
      const creates = stmts.filter((s) => /CREATE INDEX/.test(s))
      for (const s of creates) {
        expect(s).toMatch(/CONCURRENTLY/)
        expect(s).toMatch(/IF NOT EXISTS/)
      }
    })
  })

  describe('down', () => {
    it('drops idx_settlements_bond_settled_at', async () => {
      await down(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_settlements_bond_settled_at'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/)
    })

    it('drops idx_settlements_transaction_hash', async () => {
      await down(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_settlements_transaction_hash'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/)
    })

    it('drops idx_bonds_identity_created_at', async () => {
      await down(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_bonds_identity_created_at'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/)
    })

    it('drops idx_bonds_active_bond_end', async () => {
      await down(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_bonds_active_bond_end'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/)
    })

    it('issues exactly four DROP INDEX statements', async () => {
      await down(pgm)
      const stmts = sqlOf(pgm)
      const drops = stmts.filter((s) => /DROP INDEX/.test(s))
      expect(drops).toHaveLength(4)
    })

    it('up and down are symmetric (every created index has a matching drop)', async () => {
      const upPgm = createMockPgm()
      const downPgm = createMockPgm()

      await up(upPgm)
      await down(downPgm)

      const upStmts = sqlOf(upPgm)
      const downStmts = sqlOf(downPgm)

      const indexNamePattern = /idx_[a-z0-9_]+/g
      const upNames = new Set(upStmts.flatMap((s) => s.match(indexNamePattern) ?? []))
      const downNames = new Set(downStmts.flatMap((s) => s.match(indexNamePattern) ?? []))

      expect(upNames).toEqual(downNames)
    })
  })
})
