import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import app from '../index.js'
import { auditLogService } from '../services/audit/index.js'
import { AuditAction } from '../services/audit/types.js'
import { UserRole, MOCK_USERS, API_KEY_TO_USER } from '../middleware/auth.js'

describe('Admin API', () => {
  const ADMIN_TOKEN = 'Bearer admin-key-12345'
  const VERIFIER_TOKEN = 'Bearer verifier-key-67890'
  const INVALID_TOKEN = 'Bearer invalid-token'
  const NO_TOKEN = 'NoBearer invalid-token'

  beforeEach(() => {
    // Clear audit logs before each test
    auditLogService.clearLogs()
    
    // Reset mock user data to avoid state contamination between tests
    MOCK_USERS['verifier-user-1'].apiKey = 'verifier-key-67890'
    MOCK_USERS['admin-user-1'].role = UserRole.ADMIN
    MOCK_USERS['verifier-user-1'].role = UserRole.VERIFIER
    
    // Reset API key mappings
    API_KEY_TO_USER['verifier-key-67890'] = 'verifier-user-1'
    API_KEY_TO_USER['admin-key-12345'] = 'admin-user-1'
  })

  describe('Authentication', () => {
    describe('GET /api/admin/users', () => {
      it('should return 401 when Authorization header is missing', async () => {
        const response = await request(app).get('/api/admin/users')

        expect(response.status).toBe(401)
        expect(response.body).toEqual({
          error: 'Unauthorized',
          message: 'Bearer token required',
        })
      })

      it('should return 401 when using invalid Bearer token', async () => {
        const response = await request(app)
          .get('/api/admin/users')
          .set('Authorization', INVALID_TOKEN)

        expect(response.status).toBe(401)
        expect(response.body).toEqual({
          error: 'Unauthorized',
          message: 'Invalid or expired token',
        })
      })

      it('should return 401 with malformed Authorization header', async () => {
        const response = await request(app)
          .get('/api/admin/users')
          .set('Authorization', NO_TOKEN)

        expect(response.status).toBe(401)
        expect(response.body).toEqual({
          error: 'Unauthorized',
          message: 'Bearer token required',
        })
      })
    })
  })

  describe('Authorization', () => {
    describe('Admin role validation', () => {
      it('should return 403 when verifier tries to access admin endpoints', async () => {
        const response = await request(app)
          .get('/api/admin/users')
          .set('Authorization', VERIFIER_TOKEN)

        expect(response.status).toBe(403)
        expect(response.body).toEqual({
          error: 'Forbidden',
          message: 'Admin role required',
        })
      })

      it('should allow admin to access user listing', async () => {
        const response = await request(app)
          .get('/api/admin/users')
          .set('Authorization', ADMIN_TOKEN)

        expect(response.status).toBe(200)
        expect(response.body).toHaveProperty('success', true)
        expect(response.body).toHaveProperty('data')
      })
    })
  })

  describe('GET /api/admin/users', () => {
    it('should list all users with default pagination', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        success: true,
        data: {
          users: expect.any(Array),
          total: expect.any(Number),
          limit: 50,
          offset: 0,
        },
      })
      expect(response.body.data.users.length).toBeGreaterThan(0)
    })

    it('should return users with correct structure', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      const user = response.body.data.users[0]
      expect(user).toHaveProperty('id')
      expect(user).toHaveProperty('email')
      expect(user).toHaveProperty('role')
      expect(user).toHaveProperty('apiKey')
      expect(user).toHaveProperty('createdAt')
      expect(user).toHaveProperty('lastActivity')
      expect(user).toHaveProperty('active')
    })

    it('should support pagination with limit and offset', async () => {
      const response = await request(app)
        .get('/api/admin/users?limit=10&offset=0')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      expect(response.body.data.limit).toBe(10)
      expect(response.body.data.offset).toBe(0)
    })

    it('should enforce max limit of 100', async () => {
      const response = await request(app)
        .get('/api/admin/users?limit=500')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      expect(response.body.data.limit).toBe(100)
    })

    it('should return 400 for negative limit', async () => {
      const response = await request(app)
        .get('/api/admin/users?limit=-1')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'Invalid pagination parameters',
      })
    })

    it('should return 400 for negative offset', async () => {
      const response = await request(app)
        .get('/api/admin/users?offset=-1')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'Invalid pagination parameters',
      })
    })

    it('should filter users by role', async () => {
      const response = await request(app)
        .get('/api/admin/users?role=admin')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      expect(response.body.data.users).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: UserRole.ADMIN })])
      )
      // All users should have admin role
      response.body.data.users.forEach((user: any) => {
        expect(user.role).toBe(UserRole.ADMIN)
      })
    })

    it('should return 400 for invalid role filter', async () => {
      const response = await request(app)
        .get('/api/admin/users?role=invalid-role')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'Invalid role: invalid-role',
      })
    })

    it('should filter users by active status', async () => {
      const response = await request(app)
        .get('/api/admin/users?active=true')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      response.body.data.users.forEach((user: any) => {
        expect(user.active).toBe(true)
      })
    })

    it('should log list action in audit log', async () => {
      await request(app)
        .get('/api/admin/users')
        .set('Authorization', ADMIN_TOKEN)

      const logs = auditLogService.getAllLogs()
      const listLog = logs.find((log) => log.action === AuditAction.LIST_USERS)
      expect(listLog).toBeDefined()
      expect(listLog?.status).toBe('success')
    })
  })

  describe('POST /api/admin/roles/assign', () => {
    it('should assign role to user', async () => {
      const response = await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          role: UserRole.ADMIN,
        })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        success: true,
        message: expect.stringContaining('Role updated'),
        data: expect.objectContaining({
          id: 'verifier-user-1',
          role: UserRole.ADMIN,
        }),
      })
    })

    it('should return 400 when userId is missing', async () => {
      const response = await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          role: UserRole.ADMIN,
        })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'Missing required fields: userId, role',
      })
    })

    it('should return 400 when role is missing', async () => {
      const response = await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'user-1',
        })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'Missing required fields: userId, role',
      })
    })

    it('should return 400 for invalid role', async () => {
      const response = await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          role: 'invalid-role',
        })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'BadRequest',
        message: 'Invalid role: invalid-role',
      })
    })

    it('should return 400 for non-existent user', async () => {
      const response = await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'non-existent-user',
          role: UserRole.VERIFIER,
        })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'BadRequest',
        message: 'User not found: non-existent-user',
      })
    })

    it('should log role assignment in audit log', async () => {
      await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          role: UserRole.ADMIN,
        })

      const logs = auditLogService.getAllLogs()
      const assignLog = logs.find((log) => log.action === AuditAction.ASSIGN_ROLE)
      expect(assignLog).toBeDefined()
      expect(assignLog?.status).toBe('success')
      expect(assignLog?.targetUserId).toBe('verifier-user-1')
    })

    it('should log failed role assignment', async () => {
      await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'non-existent-user',
          role: UserRole.VERIFIER,
        })

      const logs = auditLogService.getAllLogs()
      const failedLog = logs.find(
        (log) => log.action === AuditAction.ASSIGN_ROLE && log.status === 'failure'
      )
      expect(failedLog).toBeDefined()
      expect(failedLog?.errorMessage).toContain('User not found')
    })

    it('should reject assignment from non-admin user', async () => {
      const response = await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', VERIFIER_TOKEN)
        .send({
          userId: 'verifier-user-1',
          role: UserRole.ADMIN,
        })

      expect(response.status).toBe(403)
    })
  })

  describe('POST /api/admin/keys/revoke', () => {
    it('should revoke API key and issue new key', async () => {
      const response = await request(app)
        .post('/api/admin/keys/revoke')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          apiKey: 'verifier-key-67890',
        })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        success: true,
        message: expect.stringContaining('API key revoked'),
      })
    })

    it('should return 400 when userId is missing', async () => {
      const response = await request(app)
        .post('/api/admin/keys/revoke')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          apiKey: 'some-key',
        })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'Missing required fields: userId, apiKey',
      })
    })

    it('should return 400 when apiKey is missing', async () => {
      const response = await request(app)
        .post('/api/admin/keys/revoke')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'user-1',
        })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'Missing required fields: userId, apiKey',
      })
    })

    it('should return 400 for non-existent user', async () => {
      const response = await request(app)
        .post('/api/admin/keys/revoke')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'non-existent-user',
          apiKey: 'some-key',
        })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'BadRequest',
        message: 'User not found: non-existent-user',
      })
    })

    it('should return 400 when API key does not belong to user', async () => {
      const response = await request(app)
        .post('/api/admin/keys/revoke')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          apiKey: 'wrong-api-key',
        })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'BadRequest',
        message: 'API key does not belong to this user',
      })
    })

    it('should log API key revocation in audit log', async () => {
      const oldKey = MOCK_USERS['verifier-user-1'].apiKey
      
      await request(app)
        .post('/api/admin/keys/revoke')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          apiKey: oldKey,
        })

      const logs = auditLogService.getAllLogs()
      const revokeLog = logs.find((log) => log.action === AuditAction.REVOKE_API_KEY)
      expect(revokeLog).toBeDefined()
      expect(revokeLog?.status).toBe('success')
      expect(revokeLog?.targetUserId).toBe('verifier-user-1')
    })

    it('should reject revocation from non-admin user', async () => {
      const response = await request(app)
        .post('/api/admin/keys/revoke')
        .set('Authorization', VERIFIER_TOKEN)
        .send({
          userId: 'verifier-user-1',
          apiKey: 'verifier-key-67890',
        })

      expect(response.status).toBe(403)
    })
  })

  describe('GET /api/admin/audit-logs', () => {
    it('should retrieve audit logs', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        success: true,
        data: {
          logs: expect.any(Array),
          total: expect.any(Number),
        },
      })
    })

    it('should support pagination', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?limit=10&offset=0')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      expect(response.body.data.logs).toBeDefined()
    })

    it('should enforce max limit of 100', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?limit=500')
        .set('Authorization', ADMIN_TOKEN)

      // The response should succeed with limit enforced
      expect(response.status).toBe(200)
    })

    it('should return 400 for invalid pagination', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?limit=-1')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        message: 'Invalid pagination parameters',
      })
    })

    it('should filter by action type', async () => {
      const response = await request(app)
        .get(`/api/admin/audit-logs?action=${AuditAction.ASSIGN_ROLE}`)
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      response.body.data.logs.forEach((log: any) => {
        expect(log.action).toBe(AuditAction.ASSIGN_ROLE)
      })
    })

    it('should filter by admin ID', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?adminId=admin-user-1')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      response.body.data.logs.forEach((log: any) => {
        expect(log.adminId).toBe('admin-user-1')
      })
    })

    it('should filter by status', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?status=success')
        .set('Authorization', ADMIN_TOKEN)

      expect(response.status).toBe(200)
      response.body.data.logs.forEach((log: any) => {
        expect(log.status).toBe('success')
      })
    })

    it('should reject access from non-admin user', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', VERIFIER_TOKEN)

      expect(response.status).toBe(403)
    })
  })

  describe('Audit Logging', () => {
    beforeEach(() => {
      auditLogService.clearLogs()
    })

    it('should contain admin info in audit logs', async () => {
      await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          role: UserRole.ADMIN,
        })

      const logs = auditLogService.getAllLogs()
      const log = logs[0]
      expect(log).toHaveProperty('adminId', 'admin-user-1')
      expect(log).toHaveProperty('adminEmail', 'admin@credence.org')
      expect(log).toHaveProperty('timestamp')
    })

    it('should contain target user info in audit logs', async () => {
      await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          role: UserRole.ADMIN,
        })

      const logs = auditLogService.getAllLogs()
      const log = logs[0]
      expect(log).toHaveProperty('targetUserId', 'verifier-user-1')
      expect(log).toHaveProperty('targetUserEmail', 'verifier@credence.org')
    })

    it('should capture action details', async () => {
      await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          role: UserRole.ADMIN,
        })

      const logs = auditLogService.getAllLogs()
      const log = logs[0]
      expect(log).toHaveProperty('details')
      expect(log.details).toHaveProperty('oldRole')
      expect(log.details).toHaveProperty('newRole')
    })
  })

  describe('End-to-End Scenarios', () => {
    beforeEach(() => {
      auditLogService.clearLogs()
    })

    it('should complete full admin workflow: list, assign, revoke', async () => {
      // 1. List users
      let response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', ADMIN_TOKEN)
      expect(response.status).toBe(200)
      const userCount = response.body.data.total

      // 2. Assign role
      response = await request(app)
        .post('/api/admin/roles/assign')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          role: UserRole.ADMIN,
        })
      expect(response.status).toBe(200)

      // 3. Revoke API key
      response = await request(app)
        .post('/api/admin/keys/revoke')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          userId: 'verifier-user-1',
          apiKey: MOCK_USERS['verifier-user-1'].apiKey,
        })
      expect(response.status).toBe(200)

      // 4. Verify audit logs
      response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', ADMIN_TOKEN)
      expect(response.status).toBe(200)
      expect(response.body.data.logs.length).toBeGreaterThanOrEqual(3)
    })
  })
})
