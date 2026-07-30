import { describe, it, expect, vi, beforeEach } from 'vitest'
import { up, down } from '../028_add_audit_logs_occurred_at_tenant_id_index.js'
import type { MigrationBuilder } from 'node-pg-migrate'

function createMockPgm(): MigrationBuilder {
  return {
    sql: vi.fn(),
  } as unknown as MigrationBuilder
}

const sqlOf = (pgm: MigrationBuilder): string[] =>
  vi.mocked(pgm.sql).mock.calls.map((call) => call[0] as string)

describe('028_add_audit_logs_occurred_at_tenant_id_index', () => {
  let pgm: MigrationBuilder

  beforeEach(() => {
    pgm = createMockPgm()
  })

  describe('up', () => {
    it('creates an index on audit_logs for (occurred_at DESC, tenant_id)', async () => {
      await up(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_audit_logs_occurred_at_tenant_id'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/CREATE INDEX/)
      expect(stmt).toMatch(/ON audit_logs \(occurred_at DESC, tenant_id\)/)
    })
  })

  describe('down', () => {
    it('drops the index on audit_logs for (occurred_at DESC, tenant_id)', async () => {
      await down(pgm)

      const stmts = sqlOf(pgm)
      const stmt = stmts.find((s) => s.includes('idx_audit_logs_occurred_at_tenant_id'))
      expect(stmt).toBeDefined()
      expect(stmt).toMatch(/DROP INDEX/)
    })
  })
})