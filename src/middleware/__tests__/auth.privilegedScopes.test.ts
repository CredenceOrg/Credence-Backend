/**
 * Regression coverage for the authorization boundary added to
 * `requireApiKey` in src/middleware/auth.ts.
 *
 * Background: the legacy 'full'/'enterprise' scope alias is treated by
 * `scopeSatisfies` as a superset of every granular ApiScope. Because any
 * authenticated user can self-issue an integration key (see
 * routes/apiKeys.ts), a key's stored scope alone was not sufficient proof
 * of platform-operator trust for privileged operational scopes (admin
 * reads/writes, outbox reinject, webhook secret rotation) that mutate
 * cross-tenant server state. `requireApiKey` now re-verifies the key
 * owner's CURRENT role from `userRepo` before granting one of those
 * scopes — this file exercises that boundary directly.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireApiKey, ApiScope } from '../auth.js'
import { generateApiKey, _resetStore, _setUseInMemory } from '../../services/apiKeys.js'
import { userRepo } from '../../repositories/userRepository.js'

function appFor(scope: ApiScope) {
  const app = express()
  app.get('/protected', requireApiKey(scope), (_req, res) => {
    res.status(200).json({ ok: true })
  })
  return app
}

const PRIVILEGED_SCOPES = [
  ApiScope.ADMIN_READ,
  ApiScope.ADMIN_WRITE,
  ApiScope.OUTBOX_REINJECT,
  ApiScope.WEBHOOKS_ADMIN,
]

describe('requireApiKey — privileged scope authorization boundary', () => {
  beforeEach(() => {
    _setUseInMemory(true)
    _resetStore()
    userRepo._reset()
  })

  describe.each(PRIVILEGED_SCOPES)('scope %s', (scope) => {
    it('denies a self-issued full/enterprise key owned by a non-admin user (privilege escalation)', async () => {
      userRepo.upsert({ id: 'user-1', role: 'user', email: 'u@test.com', tenantId: 'tenant-a', active: true })
      const key = generateApiKey('user-1', 'full')

      const res = await request(appFor(scope))
        .get('/protected')
        .set('Authorization', `Bearer ${key.key}`)

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Forbidden')
    })

    it('denies a key directly granted the granular scope when the owner is not an admin', async () => {
      userRepo.upsert({ id: 'user-2', role: 'user', email: 'u2@test.com', tenantId: 'tenant-a', active: true })
      const key = generateApiKey('user-2', [scope])

      const res = await request(appFor(scope))
        .get('/protected')
        .set('Authorization', `Bearer ${key.key}`)

      expect(res.status).toBe(403)
    })

    it('denies when the owner record cannot be found (missing identity)', async () => {
      const key = generateApiKey('ghost-owner', 'full')

      const res = await request(appFor(scope))
        .get('/protected')
        .set('Authorization', `Bearer ${key.key}`)

      expect(res.status).toBe(403)
    })

    it('denies when the owner was demoted from admin after the key was issued (stale identity)', async () => {
      userRepo.upsert({ id: 'admin-1', role: 'admin', email: 'a@test.com', tenantId: 'tenant-a', active: true })
      const key = generateApiKey('admin-1', 'full')

      // Role changes after issuance — the key itself is untouched.
      userRepo.updateRole('admin-1', 'user')

      const res = await request(appFor(scope))
        .get('/protected')
        .set('Authorization', `Bearer ${key.key}`)

      expect(res.status).toBe(403)
    })

    it('denies when the owner account has been deactivated', async () => {
      userRepo.upsert({ id: 'admin-2', role: 'admin', email: 'a2@test.com', tenantId: 'tenant-a', active: false })
      const key = generateApiKey('admin-2', 'full')

      const res = await request(appFor(scope))
        .get('/protected')
        .set('Authorization', `Bearer ${key.key}`)

      expect(res.status).toBe(403)
    })

    it('allows an admin-owned full/enterprise key', async () => {
      userRepo.upsert({ id: 'admin-3', role: 'admin', email: 'a3@test.com', tenantId: 'tenant-a', active: true })
      const key = generateApiKey('admin-3', 'full')

      const res = await request(appFor(scope))
        .get('/protected')
        .set('Authorization', `Bearer ${key.key}`)

      expect(res.status).toBe(200)
    })

    it('allows a super-admin-owned key granted the exact granular scope', async () => {
      userRepo.upsert({ id: 'super-1', role: 'super-admin', email: 's@test.com', tenantId: 'tenant-a', active: true })
      const key = generateApiKey('super-1', [scope])

      const res = await request(appFor(scope))
        .get('/protected')
        .set('Authorization', `Bearer ${key.key}`)

      expect(res.status).toBe(200)
    })

    it('repeated requests with the same denied key stay denied and never reach the handler', async () => {
      userRepo.upsert({ id: 'user-3', role: 'user', email: 'u3@test.com', tenantId: 'tenant-a', active: true })
      const key = generateApiKey('user-3', 'full')
      const app = appFor(scope)

      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/protected').set('Authorization', `Bearer ${key.key}`)
        expect(res.status).toBe(403)
      }
    })
  })

  it('does not require admin ownership for non-privileged scopes (no behavior change outside the boundary)', async () => {
    userRepo.upsert({ id: 'user-4', role: 'user', email: 'u4@test.com', tenantId: 'tenant-a', active: true })
    const key = generateApiKey('user-4', 'full')

    const res = await request(appFor(ApiScope.TRUST_READ))
      .get('/protected')
      .set('Authorization', `Bearer ${key.key}`)

    expect(res.status).toBe(200)
  })

  it('still enforces normal scope matching before the admin-ownership check runs', async () => {
    userRepo.upsert({ id: 'admin-4', role: 'admin', email: 'a4@test.com', tenantId: 'tenant-a', active: true })
    // Admin-owned, but the key itself was only granted a read scope.
    const key = generateApiKey('admin-4', [ApiScope.TRUST_READ])

    const res = await request(appFor(ApiScope.ADMIN_WRITE))
      .get('/protected')
      .set('Authorization', `Bearer ${key.key}`)

    expect(res.status).toBe(403)
  })
})
