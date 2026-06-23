import { describe, it, expect, vi, beforeEach } from 'vitest'
import { up, down } from './006_add_hot_path_partial_indexes.js'
import type { MigrationBuilder } from 'node-pg-migrate'

function createMockPgm(): MigrationBuilder {
  return {
    sql: vi.fn(),
  } as unknown as MigrationBuilder
}

const sqlOf = (pgm: MigrationBuilder): string[] =>
  vi.mocked(pgm.sql).mock.calls.map((call) => call[0] as string)

describe('006_add_hot_path_partial_indexes', () => {
  let pgm: MigrationBuilder

  beforeEach(() => {
    pgm = createMockPgm()
  })

  describe('up', () => {
    it('creates a partial index on failed_inbound_events for status=failed', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_failed_inbound_events_status_failed_created'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
      expect(stmt).toMatch(/ON failed_inbound_events \(created_at DESC\)/)
      expect(stmt).toMatch(/WHERE status = 'failed'/)
    })

    it('creates a partial index on audit_logs for status=failure', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_audit_logs_status_failure_time'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
      expect(stmt).toMatch(/ON audit_logs \(occurred_at DESC\)/)
      expect(stmt).toMatch(/WHERE status = 'failure'/)
    })

    it('creates a partial index on report_jobs for queued/running status', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_report_jobs_status_active_created'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
      expect(stmt).toMatch(/ON report_jobs \(created_at\)/)
      expect(stmt).toMatch(/WHERE status IN \('queued', 'running'\)/)
    })

    it('creates a partial index on settlements for status=pending', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_settlements_status_pending_bond'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
      expect(stmt).toMatch(/ON settlements \(bond_id, settled_at DESC\)/)
      expect(stmt).toMatch(/WHERE status = 'pending'/)
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
    it('drops every index created by up', async () => {
      await down(pgm)
      const stmts = sqlOf(pgm)

      const expectedNames = [
        'idx_failed_inbound_events_status_failed_created',
        'idx_audit_logs_status_failure_time',
        'idx_report_jobs_status_active_created',
        'idx_settlements_status_pending_bond',
      ]

      for (const name of expectedNames) {
        const stmt = stmts.find((s) => s.includes(name))
        expect(stmt, `expected DROP for ${name}`).toBeDefined()
        expect(stmt).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/)
      }
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
