/**
 * Tests for admin routes covering:
 * - Only-admin access control (401/403 for non-admin users)
 * - Idempotent mutation endpoints (Idempotency-Key header)
 * - Audit logging on every admin action
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import { auditLogService, AuditAction } from '../../services/audit/index.js'
import { userRepo } from '../../repositories/userRepository.js'

// ── Hoisted mock pool (stable across tests) ────────────────────────

vi.mock('../../db/pool.js', () => {
  const idempotencyStore = new Map<string, any>()
  const mockPool = {
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
        const [key, actorId, requestHash, responseCode, responseBody, ttlSeconds, expiresAt] = params
        idempotencyStore.set(key, {
          key,
          actor_id: actorId,
          request_hash: requestHash,
          response_code: responseCode,
          response_body: responseBody,
          ttl_seconds: ttlSeconds,
          expires_at: expiresAt,
          created_at: new Date(),
        })
        return { rowCount: 1 }
      }

      return { rows: [], rowCount: 0 }
    }),
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  }

  return {
    pool: mockPool,
    workerPool: mockPool,
    replicaPool: mockPool,
    apiPreparedStatementCache: { size: 0 },
    workerPreparedStatementCache: { size: 0 },
    replicaPreparedStatementCache: { size: 0 },
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

function seedTestUsers() {
  userRepo._reset()
  userRepo.upsert({
    id: 'admin-user-1',
    role: 'super-admin',
    email: 'admin@credence.org',
    tenantId: 'tenant-admin',
    active: true,
  })
  userRepo.upsert({
    id: 'verifier-user-1',
    role: 'verifier',
    email: 'verifier@credence.org',
    tenantId: 'tenant-verifier',
    active: true,
  })
}

// ── Admin auth helpers ─────────────────────────────────────────────

const ADMIN_AUTH = { Authorization: 'Bearer admin-key-12345' }
const VERIFIER_AUTH = { Authorization: 'Bearer verifier-key-67890' }
const FAKE_AUTH = { Authorization: 'Bearer fake-key-99999' }

// ── Tests ──────────────────────────────────────────────────────────

describe('Admin Routes — Only-Admin Access Control', () => {
  let app: Express

  beforeEach(async () => {
    seedTestUsers()
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
    seedTestUsers()
    const { createAdminRouter } = await import('./index.js')
    app = express()
    app.use(express.json())
    app.use('/api/admin', createAdminRouter())
    app.use(errorHandler)
  })

  it('processes_new_idempotency_key_for_role_assignment', async () => {
    const headers = { ...ADMIN_AUTH, 'idempotency-key': 'ia-test-new-1' }
    const payload = { userId: 'admin-user-1', role: 'admin' }

    const res = await request(app, 'POST', '/api/admin/roles/assign', headers, payload)
    expect(res.status).toBe(200)
    expect((res.body as any).success).toBe(true)
  })

  it('replays_response_for_same_idempotency_key', async () => {
    const key = 'ia-test-replay-1'
    const headers = { ...ADMIN_AUTH, 'idempotency-key': key }
    const payload = { userId: 'admin-user-1', role: 'admin' }

    const res1 = await request(app, 'POST', '/api/admin/roles/assign', headers, payload)
    expect(res1.status).toBe(200)

    const res2 = await request(app, 'POST', '/api/admin/roles/assign', headers, payload)
    expect(res2.status).toBe(200)
    expect(res2.body).toEqual(res1.body)
  })

  it('rejects_different_payload_for_same_key', async () => {
    const key = 'ia-test-conflict-1'
    const headers = { ...ADMIN_AUTH, 'idempotency-key': key }

    await request(app, 'POST', '/api/admin/roles/assign', headers, { userId: 'admin-user-1', role: 'admin' })

    const { status, body } = await request(app, 'POST', '/api/admin/roles/assign', headers, { userId: 'admin-user-1', role: 'super-admin' })
    expect(status).toBe(409)
    expect((body as any).code).toBe('idempotency_key_mismatch')
  })

  it('allows_different_keys_for_same_payload', async () => {
    const payload = { userId: 'admin-user-1', role: 'admin' }

    const res1 = await request(app, 'POST', '/api/admin/roles/assign', { ...ADMIN_AUTH, 'idempotency-key': 'ia-test-key-a' }, payload)
    const res2 = await request(app, 'POST', '/api/admin/roles/assign', { ...ADMIN_AUTH, 'idempotency-key': 'ia-test-key-b' }, payload)

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
  })

  it('does_not_interfere_when_no_idempotency_key', async () => {
    const payload = { userId: 'admin-user-1', role: 'admin' }

    const res = await request(app, 'POST', '/api/admin/roles/assign', ADMIN_AUTH, payload)
    expect(res.status).toBe(200)
    expect((res.body as any).success).toBe(true)
  })

  it('applies_idempotency_to_key_revocation', async () => {
    const key = 'ia-test-key-revoke-1'
    const headers = { ...ADMIN_AUTH, 'idempotency-key': key }
    const payload = { userId: 'verifier-user-1', apiKey: 'verifier-key-67890' }

    const res1 = await request(app, 'POST', '/api/admin/keys/revoke', headers, payload)
    expect(res1.status).toBe(200)

    const res2 = await request(app, 'POST', '/api/admin/keys/revoke', headers, payload)
    expect(res2.status).toBe(200)
    expect(res2.body).toEqual(res1.body)
  })
})

describe('Admin Routes — Audit Logged Actions', () => {
  let app: Express

  beforeEach(async () => {
    seedTestUsers()
    await auditLogService.clearLogs()
    const { createAdminRouter } = await import('./index.js')
    app = express()
    app.use(express.json())
    app.use('/api/admin', createAdminRouter())
    app.use(errorHandler)
  })

  it('does_not_log_on_auth_failure', async () => {
    await request(app, 'POST', '/api/admin/roles/assign', {}, { userId: 'admin-user-1', role: 'admin' })

    const logs = await auditLogService.getAllLogs()
    const roleLogs = logs.filter((l) => l.action === AuditAction.ASSIGN_ROLE)
    expect(roleLogs.length).toBe(0)
  })

  it('does_not_log_on_authorization_failure', async () => {
    await request(app, 'POST', '/api/admin/roles/assign', VERIFIER_AUTH, { userId: 'admin-user-1', role: 'admin' })

    const logs = await auditLogService.getAllLogs()
    const roleLogs = logs.filter((l) => l.action === AuditAction.ASSIGN_ROLE)
    expect(roleLogs.length).toBe(0)
  })

  it('logs_role_assignment_on_success', async () => {
    const payload = { userId: 'admin-user-1', role: 'admin' }
    await request(app, 'POST', '/api/admin/roles/assign', ADMIN_AUTH, payload)

    const logs = await auditLogService.getAllLogs()
    const roleLogs = logs.filter((l) => l.action === AuditAction.ASSIGN_ROLE)
    expect(roleLogs.length).toBeGreaterThanOrEqual(1)
    const lastLog = roleLogs[roleLogs.length - 1]
    expect(lastLog.actorId).toBe('admin-user-1')
    expect(lastLog.actorEmail).toBe('admin@credence.org')
    expect(lastLog.resourceId).toBe('admin-user-1')
    expect(lastLog.status).toBe('success')
    expect(lastLog.details).toHaveProperty('oldRole')
    expect(lastLog.details).toHaveProperty('newRole', 'admin')
  })

  it('logs_invalid_role_attempt_as_failure', async () => {
    const payload = { userId: 'admin-user-1', role: 'nonexistent-role' }
    await request(app, 'POST', '/api/admin/roles/assign', ADMIN_AUTH, payload)

    const logs = await auditLogService.getAllLogs()
    const roleLogs = logs.filter((l) => l.action === AuditAction.ASSIGN_ROLE)
    expect(roleLogs.length).toBeGreaterThanOrEqual(1)
    const lastLog = roleLogs[roleLogs.length - 1]
    expect(lastLog.status).toBe('failure')
  })

  it('logs_user_not_found_as_failure', async () => {
    const payload = { userId: 'nonexistent-user', role: 'admin' }
    await request(app, 'POST', '/api/admin/roles/assign', ADMIN_AUTH, payload)

    const logs = await auditLogService.getAllLogs()
    const roleLogs = logs.filter((l) => l.action === AuditAction.ASSIGN_ROLE)
    expect(roleLogs.length).toBeGreaterThanOrEqual(1)
    const lastLog = roleLogs[roleLogs.length - 1]
    expect(lastLog.status).toBe('failure')
  })

  it('logs_multiple_actions_independently', async () => {
    await request(app, 'POST', '/api/admin/roles/assign', ADMIN_AUTH, { userId: 'admin-user-1', role: 'admin' })
    await request(app, 'POST', '/api/admin/keys/revoke', ADMIN_AUTH, { userId: 'verifier-user-1', apiKey: 'verifier-key-67890' })

    const logs = await auditLogService.getAllLogs()
    const assignLogs = logs.filter((l) => l.action === AuditAction.ASSIGN_ROLE)
    const revokeLogs = logs.filter((l) => l.action === AuditAction.REVOKE_API_KEY)
    expect(assignLogs.length).toBeGreaterThanOrEqual(1)
    expect(revokeLogs.length).toBeGreaterThanOrEqual(1)
  })

  it('logs_key_revocation_on_success', async () => {
    const payload = { userId: 'admin-user-1', apiKey: 'admin-key-12345' }
    await request(app, 'POST', '/api/admin/keys/revoke', ADMIN_AUTH, payload)

    const logs = await auditLogService.getAllLogs()
    const revokeLogs = logs.filter((l) => l.action === AuditAction.REVOKE_API_KEY)
    expect(revokeLogs.length).toBeGreaterThanOrEqual(1)
    const lastLog = revokeLogs[revokeLogs.length - 1]
    expect(lastLog.actorId).toBe('admin-user-1')
    expect(lastLog.status).toBe('success')
  })
})
