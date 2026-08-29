import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import migrationsRouter from './migrations.js'
import { dryRunMigration } from '../../migrations/runner.js'

vi.mock('../../middleware/auth.js', () => ({
  UserRole: {
    ADMIN: 'admin',
    VERIFIER: 'verifier',
    USER: 'user',
  },
  requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
    ;(req as any).user = { id: 'admin-1', email: 'admin@test.com', role: 'admin' }
    next()
  },
  requireAdminRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

vi.mock('../../migrations/runner.js', () => ({
  dryRunMigration: vi.fn(),
}))

function setupApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/migrations', migrationsRouter)
  return app
}

describe('Admin Migrations Router - Dry Run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /api/admin/migrations/dry-run', () => {
    it('returns SQL dry run results successfully for GET', async () => {
      vi.mocked(dryRunMigration).mockResolvedValueOnce({
        success: true,
        applied: ['001_initial_schema.ts'],
        sql: ['CREATE TABLE test (id SERIAL PRIMARY KEY);'],
      })

      const res = await request(setupApp()).get('/api/admin/migrations/dry-run')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.applied).toEqual(['001_initial_schema.ts'])
      expect(res.body.data.sql).toEqual(['CREATE TABLE test (id SERIAL PRIMARY KEY);'])
      expect(res.body.data.sqlText).toBe('CREATE TABLE test (id SERIAL PRIMARY KEY);')
      expect(res.body.data.count).toBe(1)
      expect(dryRunMigration).toHaveBeenCalledWith({
        count: undefined,
        file: undefined,
        skipPreflight: false,
        verbose: false,
      })
    })

    it('passes query parameters to dryRunMigration', async () => {
      vi.mocked(dryRunMigration).mockResolvedValueOnce({
        success: true,
        applied: ['002_add_users.ts'],
        sql: ['ALTER TABLE users ADD COLUMN name TEXT;'],
      })

      const res = await request(setupApp())
        .get('/api/admin/migrations/dry-run?count=1&skipPreflight=true')

      expect(res.status).toBe(200)
      expect(dryRunMigration).toHaveBeenCalledWith({
        count: 1,
        file: undefined,
        skipPreflight: true,
        verbose: false,
      })
    })

    it('handles dry-run failure gracefully for GET', async () => {
      vi.mocked(dryRunMigration).mockResolvedValueOnce({
        success: false,
        applied: [],
        error: 'Database connection failed',
      })

      const res = await request(setupApp()).get('/api/admin/migrations/dry-run')

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toBe('MigrationDryRunFailed')
      expect(res.body.message).toBe('Database connection failed')
    })
  })

  describe('POST /api/admin/migrations/dry-run', () => {
    it('returns SQL dry run results successfully for POST', async () => {
      vi.mocked(dryRunMigration).mockResolvedValueOnce({
        success: true,
        applied: ['001_initial_schema.ts', '002_add_indexes.ts'],
        sql: [
          'CREATE TABLE test (id SERIAL PRIMARY KEY);',
          'CREATE INDEX idx_test_id ON test(id);',
        ],
      })

      const res = await request(setupApp())
        .post('/api/admin/migrations/dry-run')
        .send({ count: 2, skipPreflight: true })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.applied).toHaveLength(2)
      expect(res.body.data.sql).toHaveLength(2)
      expect(res.body.data.count).toBe(2)
      expect(dryRunMigration).toHaveBeenCalledWith({
        count: 2,
        file: undefined,
        skipPreflight: true,
        verbose: false,
      })
    })

    it('handles dry-run failure gracefully for POST', async () => {
      vi.mocked(dryRunMigration).mockResolvedValueOnce({
        success: false,
        applied: [],
        error: 'Syntax error in migration file',
      })

      const res = await request(setupApp())
        .post('/api/admin/migrations/dry-run')
        .send({ file: 'invalid_migration.ts' })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toBe('MigrationDryRunFailed')
      expect(res.body.message).toBe('Syntax error in migration file')
    })
  })
})
