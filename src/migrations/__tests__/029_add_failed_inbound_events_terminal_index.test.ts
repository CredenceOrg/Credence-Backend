import { describe, it, expect, vi, beforeEach } from 'vitest'
import { up, down } from '../029_add_failed_inbound_events_terminal_index.js'
import type { MigrationBuilder } from 'node-pg-migrate'

function createMockPgm(): MigrationBuilder {
  return {
    sql: vi.fn(),
  } as unknown as MigrationBuilder
}

const sqlOf = (pgm: MigrationBuilder): string[] =>
  vi.mocked(pgm.sql).mock.calls.map((call) => call[0] as string)

describe('029_add_failed_inbound_events_terminal_index', () => {
  let pgm: MigrationBuilder

  beforeEach(() => {
    pgm = createMockPgm()
  })

  describe('up', () => {
    it('creates a partial index on failed_inbound_events for replayed/skipped status', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_failed_inbound_events_terminal_created'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
      expect(stmt).toMatch(/ON failed_inbound_events \(created_at\)/)
      expect(stmt).toMatch(/WHERE status IN \('replayed', 'skipped'\)/)
    })

    it('issues exactly one CREATE INDEX statement', async () => {
      await up(pgm)
      const stmts = sqlOf(pgm)
      const creates = stmts.filter((s) => /CREATE INDEX/.test(s))
      expect(creates).toHaveLength(1)
    })

    it('uses CONCURRENTLY and IF NOT EXISTS for safety', async () => {
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
    it('drops the index created by up', async () => {
      await down(pgm)
      const stmts = sqlOf(pgm)

      const stmt = stmts.find((s) => s.includes('idx_failed_inbound_events_terminal_created'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/)
    })

    it('up and down are symmetric', async () => {
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
