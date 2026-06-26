import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { runMigration } from '../../src/migrations/runner.js'
import { ImpersonationTokenRepository } from '../../src/repositories/impersonationTokenRepository.js'
import type { ImpersonationToken } from '../../src/services/impersonation/types.js'
import { randomBytes } from 'crypto'

let db: TestDatabase
let repo: ImpersonationTokenRepository

describe('Impersonation Tokens Integration', () => {
  beforeAll(async () => {
    db = await createTestDatabase()
    repo = new ImpersonationTokenRepository(db.pool)

    if (db.connectionString.startsWith('pg-mem://')) {
      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS impersonation_tokens (
            token_id VARCHAR(255) PRIMARY KEY,
            issued_by VARCHAR(255) NOT NULL,
            issued_by_email VARCHAR(255) NOT NULL,
            target_user_id VARCHAR(255) NOT NULL,
            target_user_email VARCHAR(255) NOT NULL,
            reason TEXT NOT NULL,
            issued_at TIMESTAMP NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            revoked BOOLEAN NOT NULL DEFAULT false,
            revoked_at TIMESTAMP NULL,
            revoked_by VARCHAR(255) NULL
        )
      `)
    } else {
      const migrationResult = await runMigration({
        direction: 'up',
        config: {
          databaseUrl: db.connectionString,
          migrationsDir: 'src/migrations',
          migrationsTable: 'pgmigrations',
          migrationsSchema: 'public',
          createSchema: true,
          transactional: true,
        },
        skipPreflight: true,
      })
      if (!migrationResult.success) {
        throw new Error(`Migrations failed: ${migrationResult.error}`)
      }
    }
  }, 120000)

  afterAll(async () => {
    if (db) await db.close()
  })

  it('persists and validates a token', async () => {
    const tokenId = randomBytes(32).toString('hex')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 900 * 1000)

    const record: ImpersonationToken = {
      tokenId,
      issuedBy: 'admin-1',
      issuedByEmail: 'admin@credence.org',
      targetUserId: 'user-1',
      targetUserEmail: 'user@credence.org',
      reason: 'test',
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revoked: false,
    }

    await repo.create(record)

    const found = await repo.findValid(tokenId)
    expect(found).not.toBeNull()
    expect(found!.tokenId).toBe(tokenId)
    expect(found!.targetUserId).toBe('user-1')
  })

  it('revokes a token successfully', async () => {
    const tokenId = randomBytes(32).toString('hex')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 900 * 1000)

    const record: ImpersonationToken = {
      tokenId,
      issuedBy: 'admin-1',
      issuedByEmail: 'admin@credence.org',
      targetUserId: 'user-2',
      targetUserEmail: 'user2@credence.org',
      reason: 'revoke test',
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revoked: false,
    }

    await repo.create(record)
    
    await repo.revoke(tokenId, 'admin-2')

    const revoked = await repo.findById(tokenId)
    expect(revoked!.revoked).toBe(true)
    expect(revoked!.revokedBy).toBe('admin-2')

    const validRecord = await repo.findValid(tokenId)
    expect(validRecord).toBeNull()
  })

  it('rejects expired tokens', async () => {
    const tokenId = randomBytes(32).toString('hex')
    const now = new Date()
    const expiresAt = new Date(now.getTime() - 1000) // Expired 1 second ago

    const record: ImpersonationToken = {
      tokenId,
      issuedBy: 'admin-1',
      issuedByEmail: 'admin@credence.org',
      targetUserId: 'user-3',
      targetUserEmail: 'user3@credence.org',
      reason: 'expired test',
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revoked: false,
    }

    await repo.create(record)

    const validRecord = await repo.findValid(tokenId)
    expect(validRecord).toBeNull()
  })

  it('background sweep deletes expired tokens but keeps valid ones', async () => {
    const expiredId = randomBytes(32).toString('hex')
    const validId = randomBytes(32).toString('hex')
    const now = new Date()

    await repo.create({
      tokenId: expiredId,
      issuedBy: 'admin-1',
      issuedByEmail: 'admin@credence.org',
      targetUserId: 'user-3',
      targetUserEmail: 'user3@credence.org',
      reason: 'sweep exp test',
      issuedAt: new Date(now.getTime() - 2000).toISOString(),
      expiresAt: new Date(now.getTime() - 1000).toISOString(),
      revoked: false,
    })

    await repo.create({
      tokenId: validId,
      issuedBy: 'admin-1',
      issuedByEmail: 'admin@credence.org',
      targetUserId: 'user-3',
      targetUserEmail: 'user3@credence.org',
      reason: 'sweep val test',
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5000).toISOString(),
      revoked: false,
    })

    const deletedCount = await repo.deleteExpired()
    expect(deletedCount).toBeGreaterThanOrEqual(1)

    // Expired token should be deleted
    const expiredRecord = await repo.findById(expiredId)
    expect(expiredRecord).toBeNull()

    // Valid token should still exist
    const validRecord = await repo.findById(validId)
    expect(validRecord).not.toBeNull()
  })
})
