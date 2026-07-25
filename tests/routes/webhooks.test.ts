/**
 * @file Integration tests for webhook management routes.
 *
 * Covers:
 * ─ POST /:webhookId/rotate-secret — happy path, 404, 401, 403
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'

import { MemoryWebhookStore } from '../../src/services/webhooks/memoryStore.js'
import { AuditLogService } from '../../src/services/audit/index.js'
import { createWebhookRouter } from '../../src/routes/webhooks.js'
import type { WebhookConfig } from '../../src/services/webhooks/types.js'
import { userRepo } from '../../src/repositories/userRepository.js'
import { generateApiKey, _resetStore } from '../../src/services/apiKeys.js'
import type { InMemoryApiKeyRepository } from '../../src/services/apiKeys.js'

// Mock the audit log service to capture entries
const mockAuditLogs: any[] = []
vi.mock('../../src/services/audit/index.js', async () => {
  const actual = await vi.importActual('../../src/services/audit/index.js')
  return {
    ...actual,
    AuditLogService: vi.fn().mockImplementation(function() {
      return {
        logAction: vi.fn().mockImplementation(async (entry) => {
          mockAuditLogs.push(entry)
        }),
        getLogs: vi.fn().mockImplementation(async () => {
          return { logs: mockAuditLogs, total: mockAuditLogs.length }
        }),
      }
    }),
  }
})

const makeTokenFor = (id: string, role: 'super-admin' | 'verifier') => {
  userRepo.upsert({ id, role, email: `${id}@example.test`, tenantId: `tenant-${id}` })
  const created = generateApiKey(id, 'full')
  return `Bearer ${created.key}`
}

// ── Lightweight fetch helper ──────────────────────────────────────────────

async function request(
  app: Express,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Could not get server address'))
        return
      }

      const url = `http://127.0.0.1:${addr.port}${path}`
      const opts: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
      }
      if (options.body !== undefined) opts.body = JSON.stringify(options.body)

      fetch(url, opts)
        .then(async (res) => {
          const json = await res.json()
          server.close()
          resolve({ status: res.status, body: json })
        })
        .catch((err) => {
          server.close()
          reject(err)
        })
    })
  })
}

// ── Test data ─────────────────────────────────────────────────────────────

let ADMIN_BEARER = ''
let VERIFIER_BEARER = ''

const SEED_WEBHOOK: WebhookConfig = {
  id: 'wh-test-001',
  url: 'https://example.com/hook',
  events: ['bond.created'],
  secret: 'initial-secret-value',
  active: true,
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Webhook Routes', () => {
  let app: Express
  let store: MemoryWebhookStore
  let audit: AuditLogService
  
  const BASE = '/api/webhooks'

  beforeEach(async () => {
    // Clear mock logs
    mockAuditLogs.length = 0
    
    _resetStore()
    userRepo._reset()
    store = new MemoryWebhookStore()
    audit = new AuditLogService()
    app = express()
    app.use(express.json())
    app.use(BASE, createWebhookRouter(store, audit))

    await store.set({ ...SEED_WEBHOOK })
    ADMIN_BEARER = makeTokenFor('admin-1', 'super-admin')
    VERIFIER_BEARER = makeTokenFor('verifier-1', 'verifier')
  })

  // Helper to mount app with auth repo when needed
  function withAuth(repo?: InMemoryApiKeyRepository) {
    return { app, repo }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // POST /:webhookId/rotate-secret
  // ═══════════════════════════════════════════════════════════════════════

  describe('POST /:webhookId/rotate-secret', () => {
    it('rotates the secret and returns rotation metadata', async () => {
  const { status, body } = await request(
    app,
    'POST',
    `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`,
    { headers: { Authorization: ADMIN_BEARER, 'x-tenant-id': 'test-tenant' } },
  )

      expect(status).toBe(200)
      const data = (body as { success: boolean; data: Record<string, string> }).data
      expect((body as { success: boolean }).success).toBe(true)
      expect(data.webhookId).toBe(SEED_WEBHOOK.id)
      expect(data.newSecret).toBeTruthy()
      expect(data.newSecret).not.toBe(SEED_WEBHOOK.secret)
      expect(data.rotatedAt).toBeTruthy()
      expect(data.previousSecretExpiresAt).toBeTruthy()
    })

    it('new secret is a 64-char hex string', async () => {
      const { body } = await request(
        app,
        'POST',
        `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`,
        { headers: { Authorization: ADMIN_BEARER } },
      )

      const { newSecret } = (body as { data: { newSecret: string } }).data
      expect(newSecret).toMatch(/^[0-9a-f]{64}$/)
    })

    it('updates the store — old secret is preserved as previousSecret', async () => {
      await request(app, 'POST', `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`, {
        headers: { Authorization: ADMIN_BEARER },
      })

      const updated = await store.get(SEED_WEBHOOK.id)
      expect(updated).not.toBeNull()
      expect(updated!.secret).not.toBe(SEED_WEBHOOK.secret)
      expect(updated!.previousSecret).toBe(SEED_WEBHOOK.secret)
      expect(updated!.previousSecretExpiresAt).toBeTruthy()
      expect(updated!.secretRotatedAt).toBeTruthy()
    })

    it('previousSecretExpiresAt is ~24 h in the future', async () => {
      const before = Date.now()
      const { body } = await request(
        app,
        'POST',
        `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`,
        { headers: { Authorization: ADMIN_BEARER } },
      )

      const { previousSecretExpiresAt } = (body as { data: { previousSecretExpiresAt: string } }).data
      const expiresMs = new Date(previousSecretExpiresAt).getTime()
      const expectedMin = before + 23 * 60 * 60 * 1000
      const expectedMax = before + 25 * 60 * 60 * 1000
      expect(expiresMs).toBeGreaterThan(expectedMin)
      expect(expiresMs).toBeLessThan(expectedMax)
    })

    it('writes an audit log entry on success', async () => {
      await request(app, 'POST', `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`, {
        headers: { Authorization: ADMIN_BEARER },
      })

      // Wait a bit for async operations
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(mockAuditLogs).toHaveLength(1)
      expect(mockAuditLogs[0].action).toBe('ROTATE_WEBHOOK_SECRET')
      expect(mockAuditLogs[0].status).toBe('success')
      expect(mockAuditLogs[0].resourceId).toBe(SEED_WEBHOOK.id)
    })

    it('two consecutive rotations produce different secrets', async () => {
      const { body: b1 } = await request(
        app,
        'POST',
        `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`,
        { headers: { Authorization: ADMIN_BEARER } },
      )
      const { body: b2 } = await request(
        app,
        'POST',
        `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`,
        { headers: { Authorization: ADMIN_BEARER } },
      )

      const secret1 = (b1 as { data: { newSecret: string } }).data.newSecret
      const secret2 = (b2 as { data: { newSecret: string } }).data.newSecret
      expect(secret1).not.toBe(secret2)
    })

    it('returns 404 when webhook does not exist', async () => {
      const { status, body } = await request(
        app,
        'POST',
        `${BASE}/nonexistent-webhook/rotate-secret`,
        { headers: { Authorization: ADMIN_BEARER } },
      )

      expect(status).toBe(404)
      expect((body as { error: string }).error).toBe('NotFound')
    })

    it('writes a failure audit log entry when webhook is not found', async () => {
      await request(app, 'POST', `${BASE}/nonexistent-webhook/rotate-secret`, {
        headers: { Authorization: ADMIN_BEARER },
      })

      // Wait a bit for async operations
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(mockAuditLogs).toHaveLength(1)
      expect(mockAuditLogs[0].action).toBe('ROTATE_WEBHOOK_SECRET')
      expect(mockAuditLogs[0].status).toBe('failure')
      expect(mockAuditLogs[0].resourceId).toBe('nonexistent-webhook')
    })

    it('returns 401 when no Authorization header is provided', async () => {
      const { status, body } = await request(
        app,
        'POST',
        `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`,
      )

      expect(status).toBe(401)
      expect((body as { error: string }).error).toBe('Unauthorized')
    })

    it('returns 401 for an invalid Bearer token', async () => {
      const { status, body } = await request(
        app,
        'POST',
        `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`,
        { headers: { Authorization: 'Bearer bogus-token' } },
      )

      expect(status).toBe(401)
      expect((body as { error: string }).error).toBe('Unauthorized')
    })

    it('returns 403 when caller has verifier role (not admin)', async () => {
      const { status, body } = await request(
        app,
        'POST',
        `${BASE}/${SEED_WEBHOOK.id}/rotate-secret`,
        { headers: { Authorization: VERIFIER_BEARER } },
      )

      expect(status).toBe(403)
      expect((body as { error: string }).error).toBe('Forbidden')
    })
  })
})