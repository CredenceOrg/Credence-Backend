import { describe, it, expect, vi, beforeEach } from 'vitest'

const pgMocks = vi.hoisted(() => {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  const end = vi.fn().mockResolvedValue(undefined)
  return {
    query,
    end,
    Pool: vi.fn(function PoolMock() {
      return { query, end }
    }),
  }
})

vi.mock('pg', () => ({
  default: { Pool: pgMocks.Pool },
}))

import {
  assertResetAllowedDatabaseName,
  dropAndRecreateDatabase,
  parseTestDatabaseTarget,
  resetTestDatabase,
} from '../resetTestDatabase.js'
import { DEFAULT_TEST_DATABASE_NAME, DEFAULT_TEST_DATABASE_URL } from '../../config/testDatabase.js'
import * as runner from '../../migrations/runner.js'

describe('resetTestDatabase', () => {
  beforeEach(() => {
    pgMocks.query.mockClear()
    pgMocks.end.mockClear()
    pgMocks.Pool.mockClear()
  })

  describe('parseTestDatabaseTarget', () => {
    it('returns admin URL pointed at postgres and the target database name', () => {
      const { adminConnectionString, databaseName } = parseTestDatabaseTarget(
        DEFAULT_TEST_DATABASE_URL,
      )

      expect(databaseName).toBe(DEFAULT_TEST_DATABASE_NAME)
      expect(adminConnectionString).toContain('/postgres')
      expect(adminConnectionString).not.toContain(`/${DEFAULT_TEST_DATABASE_NAME}`)
    })

    it('rejects URLs without a database name', () => {
      expect(() => parseTestDatabaseTarget('postgresql://credence:credence@localhost:5433/')).toThrow(
        'must include a database name',
      )
    })
  })

  describe('assertResetAllowedDatabaseName', () => {
    it('allows the canonical test database name', () => {
      expect(() => assertResetAllowedDatabaseName(DEFAULT_TEST_DATABASE_NAME)).not.toThrow()
    })

    it('refuses other database names', () => {
      expect(() => assertResetAllowedDatabaseName('credence')).toThrow(/Refusing to reset/)
    })
  })

  describe('dropAndRecreateDatabase', () => {
    it('terminates connections, drops, and creates the database', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] })
      const pool = { query } as unknown as import('pg').Pool

      await dropAndRecreateDatabase(pool, DEFAULT_TEST_DATABASE_NAME)

      expect(query).toHaveBeenCalledTimes(3)
      expect(String(query.mock.calls[0][0])).toContain('pg_terminate_backend')
      expect(String(query.mock.calls[1][0])).toContain('DROP DATABASE')
      expect(String(query.mock.calls[2][0])).toContain('CREATE DATABASE')
    })
  })

  describe('resetTestDatabase', () => {
    it('refuses non-test database URLs before connecting', async () => {
      await expect(
        resetTestDatabase({
          testDatabaseUrl: 'postgresql://credence:credence@localhost:5432/credence',
          skipMigrations: true,
        }),
      ).rejects.toThrow(/Refusing to reset/)

      expect(pgMocks.Pool).not.toHaveBeenCalled()
    })

    it('applies migrations after drop/create', async () => {
      const runMigrationSpy = vi
        .spyOn(runner, 'runMigration')
        .mockResolvedValue({ success: true, applied: ['001_initial_schema'] })

      const result = await resetTestDatabase({
        testDatabaseUrl: DEFAULT_TEST_DATABASE_URL,
        migrationConfig: {
          databaseUrl: DEFAULT_TEST_DATABASE_URL,
          migrationsDir: 'dist/migrations',
          migrationsTable: 'pgmigrations',
          migrationsSchema: 'public',
          transactional: true,
          createSchema: true,
        },
      })

      expect(pgMocks.Pool).toHaveBeenCalled()
      expect(result.migrationApplied).toEqual(['001_initial_schema'])
      expect(runMigrationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ direction: 'up', skipPreflight: true }),
      )

      runMigrationSpy.mockRestore()
    })

    it('skips migrations when skipMigrations is true', async () => {
      const runMigrationSpy = vi.spyOn(runner, 'runMigration')

      const result = await resetTestDatabase({
        testDatabaseUrl: DEFAULT_TEST_DATABASE_URL,
        skipMigrations: true,
      })

      expect(result.migrationApplied).toEqual([])
      expect(runMigrationSpy).not.toHaveBeenCalled()

      runMigrationSpy.mockRestore()
    })
  })
})
