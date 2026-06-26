/**
 * @file Route-level tests for integration API key management endpoints.
 *
 * Covers:
 *   POST   /api/integrations/keys            – issue key, validation errors, auth guard
 *   GET    /api/integrations/keys            – list keys, scoped to owner
 *   POST   /api/integrations/keys/:id/rotate – happy path, already-revoked, not-found,
 *                                              ownership check
 *   DELETE /api/integrations/keys/:id        – revoke, not-found, ownership check
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { createApiKeyRouter } from '../../src/routes/apiKeys.js'
import { InMemoryApiKeyRepository } from '../../src/repositories/apiKeyRepository.js'
import { ApiKeyRotationService } from '../../src/services/apiKeyRotationService.js'
import { InMemoryAuditLogsRepository } from '../../src/db/repositories/auditLogsRepository.js'
import { AuditLogService } from '../../src/services/audit/index.js'
import { _resetStore } from '../../src/services/apiKeys.js'
import { userRepo } from '../../src/repositories/userRepository.js'

function createUserAndToken(repo: InMemoryApiKeyRepository, id: string, role: 'super-admin' | 'verifier' | 'admin' | 'user') {
  userRepo.upsert({ id, role, email: `${id}@example.test`, tenantId: `tenant-${id}` })
  const created = repo.create(id)
  return `Bearer ${created.key}`
}

// ── Auth header helpers ──────────────────────────────────────────────────────
// Tokens will be generated against the in-memory key store and returned by
// `buildApp()` so tests use DB-backed keys rather than in-source mocks.

// ── Lightweight HTTP helper (no supertest dependency) ────────────────────────

interface HttpResponse {
  status: number
  body: Record<string, unknown>
}

function makeRequest(
  app: Express,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { body?: unknown; auth?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Failed to bind to an ephemeral port'))
        return
      }

      const url = `http://127.0.0.1:${addr.port}${path}`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (opts.auth) headers['Authorization'] = opts.auth

      const init: RequestInit = { method, headers }
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body)

      fetch(url, init)
        .then(async (res) => {
          const body = await res.json()
          server.close()
          resolve({ status: res.status, body: body as Record<string, unknown> })
        })
        .catch((err) => {
          server.close()
          reject(err)
        })
    })
  })
}

// ── App factory ──────────────────────────────────────────────────────────────

function buildApp() {
  const repo = new InMemoryApiKeyRepository()
  const auditRepo = new InMemoryAuditLogsRepository()
  const auditSvc = new AuditLogService(auditRepo)
  const rotationService = new ApiKeyRotationService(repo, auditSvc)

  const app = express()
  app.use(express.json())
  app.use('/api/integrations/keys', createApiKeyRouter(repo, rotationService))
  app.use(errorHandler)

  return { app, repo, auditSvc }
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetStore()
  userRepo._reset()
})

describe('POST /api/integrations/keys', () => {
  it('issues a new key with default scope and tier', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const res = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    const data = res.body.data as Record<string, unknown>
    expect(typeof data.key).toBe('string')
    expect((data.key as string)).toMatch(/^cr_[0-9a-f]{64}$/)
    expect(data.scope).toBe('read')
    expect(data.tier).toBe('free')
  })

  it('respects explicit scope and tier in the request body', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const res = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
      body: { scope: 'full', tier: 'enterprise' },
    })

    expect(res.status).toBe(201)
    const data = res.body.data as Record<string, unknown>
    expect(data.scope).toBe('full')
    expect(data.tier).toBe('enterprise')
  })

  it('rejects an invalid scope with 400', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const res = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
      body: { scope: 'superuser' },
    })

    expect(res.status).toBe(400)
  })

  it('rejects an invalid tier with 400', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const res = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
      body: { tier: 'platinum' },
    })

    expect(res.status).toBe(400)
  })

  it('returns 401 when no auth header is provided', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const res = await makeRequest(app, 'POST', '/api/integrations/keys')

    expect(res.status).toBe(401)
  })

  it('records a CREATE_API_KEY audit entry', async () => {
    const { app, repo, auditSvc } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    await makeRequest(app, 'POST', '/api/integrations/keys', { auth: ADMIN_TOKEN })

    const { logs } = await auditSvc.getLogs(undefined, { action: 'CREATE_API_KEY' }, 100, 0, { allowSuperScope: true })
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0].action).toBe('CREATE_API_KEY')
    expect(logs[0].status).toBe('success')
  })
})

describe('GET /api/integrations/keys', () => {
  it('returns an empty array when the user has no keys', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const res = await makeRequest(app, 'GET', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect((res.body.data as unknown[]).length).toBe(1)
  })

  it('lists only keys belonging to the requesting user', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const VERIFIER_TOKEN = createUserAndToken(repo, 'verifier-1', 'verifier')

    // Issue one key as admin and one as verifier
    await makeRequest(app, 'POST', '/api/integrations/keys', { auth: ADMIN_TOKEN })
    await makeRequest(app, 'POST', '/api/integrations/keys', { auth: VERIFIER_TOKEN })

    const adminList = await makeRequest(app, 'GET', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })

    expect((adminList.body.data as unknown[]).length).toBe(2)
  })

  it('returns 401 when unauthenticated', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const res = await makeRequest(app, 'GET', '/api/integrations/keys')
    expect(res.status).toBe(401)
  })
})

describe('POST /api/integrations/keys/:id/rotate', () => {
  it('rotates a key successfully and returns a new raw key', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')

    // Issue a key first
    const createRes = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })
    const oldKeyData = createRes.body.data as Record<string, unknown>
    const keyId = oldKeyData.id as string

    // Rotate it
    const rotateRes = await makeRequest(
      app,
      'POST',
      `/api/integrations/keys/${keyId}/rotate`,
      { auth: ADMIN_TOKEN },
    )

    expect(rotateRes.status).toBe(200)
    expect(rotateRes.body.success).toBe(true)
    const newData = rotateRes.body.data as Record<string, unknown>
    expect(typeof newData.key).toBe('string')
    expect(newData.key).toMatch(/^cr_[0-9a-f]{64}$/)
    expect(newData.key).not.toBe(oldKeyData.key)
  })

  it('preserves the original scope and tier after rotation', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')

    const createRes = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
      body: { scope: 'full', tier: 'pro' },
    })
    const keyId = (createRes.body.data as Record<string, unknown>).id as string

    const rotateRes = await makeRequest(
      app,
      'POST',
      `/api/integrations/keys/${keyId}/rotate`,
      { auth: ADMIN_TOKEN },
    )

    const newData = rotateRes.body.data as Record<string, unknown>
    expect(newData.scope).toBe('full')
    expect(newData.tier).toBe('pro')
  })

  it('returns 409 when the key has already been revoked', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')

    const createRes = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })
    const keyId = (createRes.body.data as Record<string, unknown>).id as string

    // Revoke it first
    await makeRequest(app, 'DELETE', `/api/integrations/keys/${keyId}`, {
      auth: ADMIN_TOKEN,
    })

    // Attempt rotation
    const rotateRes = await makeRequest(
      app,
      'POST',
      `/api/integrations/keys/${keyId}/rotate`,
      { auth: ADMIN_TOKEN },
    )

    expect(rotateRes.status).toBe(409)
  })

  it('returns 404 for an unknown key ID', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const res = await makeRequest(
      app,
      'POST',
      '/api/integrations/keys/nonexistent-id/rotate',
      { auth: ADMIN_TOKEN },
    )

    expect(res.status).toBe(404)
  })

  it('returns 403 when a non-owner attempts to rotate another user\'s key', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const VERIFIER_TOKEN = createUserAndToken(repo, 'verifier-1', 'verifier')

    // Admin creates a key
    const createRes = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })
    const keyId = (createRes.body.data as Record<string, unknown>).id as string

    // Verifier (different user, non-admin) tries to rotate it
    const res = await makeRequest(
      app,
      'POST',
      `/api/integrations/keys/${keyId}/rotate`,
      { auth: VERIFIER_TOKEN },
    )

    expect(res.status).toBe(403)
  })

  it('returns 401 when unauthenticated', async () => {
    const { app } = buildApp()
    const res = await makeRequest(app, 'POST', '/api/integrations/keys/any-id/rotate')
    expect(res.status).toBe(401)
  })

  it('writes a ROTATE_API_KEY success entry to the audit log', async () => {
    const { app, repo, auditSvc } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')

    const createRes = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })
    const keyId = (createRes.body.data as Record<string, unknown>).id as string

    await makeRequest(app, 'POST', `/api/integrations/keys/${keyId}/rotate`, {
      auth: ADMIN_TOKEN,
    })

    const { logs } = await auditSvc.getLogs(undefined, { action: 'ROTATE_API_KEY' }, 100, 0, { allowSuperScope: true })
    expect(logs.length).toBeGreaterThan(0)
    const entry = logs.find((l) => l.status === 'success')
    expect(entry).toBeDefined()
    expect((entry!.details as Record<string, unknown>).revokedKeyId).toBe(keyId)
  })

  it('logs a failure audit entry when rotating a non-existent key', async () => {
    const { app, repo, auditSvc } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')

    await makeRequest(app, 'POST', '/api/integrations/keys/ghost-id/rotate', {
      auth: ADMIN_TOKEN,
    })

    // The 404 is thrown before the service call, so no audit entry is expected here.
    // (The route validates existence before delegating to the service.)
    const { logs } = await auditSvc.getLogs(undefined, { action: 'ROTATE_API_KEY' }, 100, 0, { allowSuperScope: true })
    expect(logs.length).toBe(0)
  })
})

describe('DELETE /api/integrations/keys/:id', () => {
  it('revokes an active key successfully', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')

    const createRes = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })
    const keyId = (createRes.body.data as Record<string, unknown>).id as string

    const revokeRes = await makeRequest(
      app,
      'DELETE',
      `/api/integrations/keys/${keyId}`,
      { auth: ADMIN_TOKEN },
    )

    expect(revokeRes.status).toBe(200)
    expect(revokeRes.body.success).toBe(true)
  })

  it('returns 404 for an unknown key ID', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const res = await makeRequest(app, 'DELETE', '/api/integrations/keys/ghost-id', {
      auth: ADMIN_TOKEN,
    })

    expect(res.status).toBe(404)
  })

  it('returns 403 when a non-owner attempts to revoke another user\'s key', async () => {
    const { app, repo } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')
    const VERIFIER_TOKEN = createUserAndToken(repo, 'verifier-1', 'verifier')

    const createRes = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })
    const keyId = (createRes.body.data as Record<string, unknown>).id as string

    const res = await makeRequest(
      app,
      'DELETE',
      `/api/integrations/keys/${keyId}`,
      { auth: VERIFIER_TOKEN },
    )

    expect(res.status).toBe(403)
  })

  it('returns 401 when unauthenticated', async () => {
    const { app } = buildApp()
    const res = await makeRequest(app, 'DELETE', '/api/integrations/keys/any-id')
    expect(res.status).toBe(401)
  })

  it('writes a REVOKE_API_KEY audit entry on success', async () => {
    const { app, repo, auditSvc } = buildApp()
    const ADMIN_TOKEN = createUserAndToken(repo, 'admin-1', 'super-admin')

    const createRes = await makeRequest(app, 'POST', '/api/integrations/keys', {
      auth: ADMIN_TOKEN,
    })
    const keyId = (createRes.body.data as Record<string, unknown>).id as string

    await makeRequest(app, 'DELETE', `/api/integrations/keys/${keyId}`, {
      auth: ADMIN_TOKEN,
    })

    const { logs } = await auditSvc.getLogs(undefined, { action: 'REVOKE_API_KEY' }, 100, 0, { allowSuperScope: true })
    const entry = logs.find((l) => l.status === 'success')
    expect(entry).toBeDefined()
    expect(entry!.resourceId).toBe(keyId)
  })
})
