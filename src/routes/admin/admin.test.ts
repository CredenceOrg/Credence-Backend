/**
 * Tests for admin routes covering:
 * - Only-admin access control (401/403 for non-admin users)
 * - Idempotent mutation endpoints (Idempotency-Key header)
 * - Audit logging on every admin action
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import { auditLogService, AuditAction } from '../../services/audit/index.js'

// ── Hoisted mock pool (stable across tests) ────────────────────────

vi.mock('../../db/pool.js', () => {
  const idempotencyStore = new Map<string, any>()

  return {
    pool: {
      query: vi.fn(async (sql: string, params: any[]) => {
        if (sql.includes('SELECT') && sql.includes('idempotency_keys')) {
          const key = params[0]
          const row = idempotencyStore.get(key)
          if (row && new Date(row.expires_at) > new Date()) {
            return { rows: [row] }
          }
          return { rows: [] }
        }

        if (sql.includes('INSERT INTO idempotency_keys') || (sql.includes('ON CONFLICT') && sql.includes('idempotency_keys'))) {
          const [key, requestHash, responseCode, responseBody, expiresAt] = params
          idempotencyStore.set(key, {
            key,
            request_hash: requestHash,
            response_code: responseCode,
            response_body: responseBody,
            expires_at: expiresAt,
            created_at: new Date(),
          })
          return { rowCount: 1 }
        }

        return { rows: [], rowCount: 0 }
      }),
    },
  }
})

// ── Helpers ────────────────────────────────────────────────────────

async function request(
  app: Express,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
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
        headers: { 'Content-Type': 'application/json', ...headers },
      }
      if (body !== undefined) opts.body = JSON.stringify(body)

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

function errorHandler(err: any, _req: any, res: any, _next: any) {
  res.status(500).json({ error: err.message || 'Internal error' })
}

// ── Admin auth helpers ─────────────────────────────────────────────

const ADMIN_AUTH = { Authorization: 'Bearer admin-key-12345' }
const VERIFIER_AUTH = { Authorization: 'Bearer verifier-key-67890' }
const FAKE_AUTH = { Authorization: 'Bearer fake-key-99999' }

// ── Tests ──────────────────────────────────────────────────────────

describe('Admin Routes — Only-Admin Access Control', () => {
  let app: Express

  beforeEach(async () => {
    const { createAdminRouter } = await import('./index.js')
    app = express()
    app.use(express.json())
    app.use('/api/admin', createAdminRouter())
    app.use(errorHandler)
  })

  it('returns_401_when_no_auth_token', async () => {
    const { status, body } = await request(app, 'POST', '/api/admin/roles/assign', {}, { userId: 'user-1', role: 'admin' })
    expect(status).toBe(401)
    expect((body as any).error).toBe('Unauthorized')
  })

  it('returns_401_for_invalid_token', async () => {
    const { status } = await request(app, 'POST', '/api/admin/roles/assign', FAKE_AUTH, { userId: 'user-1', role: 'admin' })
    expect(status).toBe(401)
  })

  it('returns_403_when_user_is_not_admin', async () => {
    const { status, body } = await request(app, 'POST', '/api/admin/roles/assign', VERIFIER_AUTH, { userId: 'user-1', role: 'admin' })
    expect(status).toBe(403)
    expect((body as any).error).toBe('Forbidden')
  })

  it('returns_403_when_user_is_not_admin_on_get_endpoint', async () => {
    const { status, body } = await request(app, 'GET', '/api/admin/users', VERIFIER_AUTH)
    expect(status).toBe(403)
    expect((body as any).error).toBe('Forbidden')
  })
})

describe('Admin Routes — Idempotent Mutations', () => {
  let app: Express

  beforeEach(async () => {
    const { createAdminRouter } = await import('./index.js')
    app = express()
    app.use(express.json())
    app.use('/api/admin', createAdminRouter())
    app.use(errorHandler)
  })

  it('processes_new_idempotency_key_for_role_assignment', async () => {
    const headers = { ...ADMIN_AUTH, 'idempotency-key': 'ia-test-new-1' }
    const payload = { userId: 'admin-user-1', role: 'admin' }

    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive, nosnippet');
  });
});

describe('POST /api/admin/replay-event', () => {
  it('should replay event with valid id', async () => {
    const { ReplayService } = await import('../../services/replayService.js')
    const mockReplayService = vi.mocked(ReplayService)
    mockReplayService.prototype.replayEvent = vi.fn().mockResolvedValue({
      success: true,
      message: 'Event successfully replayed',
    })

    const res = await request(setup())
      .post('/api/admin/replay-event')
      .send({ id: 'evt-123' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('should return 400 when id is missing', async () => {
    const res = await request(setup())
      .post('/api/admin/replay-event')
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_failed')
  })

  it('should return 400 for empty string id', async () => {
    const res = await request(setup())
      .post('/api/admin/replay-event')
      .send({ id: '' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_failed')
  })

  it('should return 400 for extra unknown fields (strict schema)', async () => {
    const res = await request(setup())
      .post('/api/admin/replay-event')
      .send({ id: 'evt-123', maliciousField: 'attack' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_failed')
  })

})