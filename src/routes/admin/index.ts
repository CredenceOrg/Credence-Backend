import { Router, Request, Response } from 'express'
import { AuthenticatedRequest, requireUserAuth, requireAdminRole, UserRole } from '../../middleware/auth.js'
import { AdminService } from '../../services/admin/index.js'
import { auditLogService } from '../../services/audit/index.js'
import type { AssignRoleRequest, RevokeApiKeyRequest } from '../../services/admin/types.js'

/**
 * Create the admin router with role and user management endpoints
 * All endpoints require admin authentication
 */
export function createAdminRouter(): Router {
  const router = Router()
  const adminService = new AdminService(auditLogService)

  /**
   * GET /api/admin/users
   * 
   * List all users with pagination and optional filtering
   * 
   * Query parameters:
   * - limit: Number of results per page (default: 50, max: 100)
   * - offset: Pagination offset (default: 0)
   * - role: Filter by role (admin, verifier, user)
   * - active: Filter by active status (true/false)
   * 
   * @requires Admin role
   * 
   * @example
   * ```bash
   * curl -X GET 'http://localhost:3000/api/admin/users?limit=10&offset=0' \
   *   -H "Authorization: Bearer admin-key-12345"
   * ```
   * 
   * @returns {object} List of users with pagination info
   */
  router.get('/users', requireUserAuth, requireAdminRole, (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!

      // Parse pagination parameters
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
      const offset = parseInt(req.query.offset as string) || 0

      if (limit < 1 || offset < 0) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'Invalid pagination parameters',
        })
        return
      }

      // Parse filter parameters
      const filters: any = {}
      if (req.query.role) {
        const validRoles = Object.values(UserRole)
        if (!validRoles.includes(req.query.role as UserRole)) {
          res.status(400).json({
            error: 'InvalidRequest',
            message: `Invalid role: ${req.query.role}`,
          })
          return
        }
        filters.role = req.query.role as UserRole
      }
      if (req.query.active !== undefined) {
        filters.active = req.query.active === 'true'
      }

      // Get users
      const result = adminService.listUsers(user.id, user.email, { limit, offset }, filters)

      res.status(200).json({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      res.status(500).json({
        error: 'InternalError',
        message,
      })
    }
  })

  /**
   * POST /api/admin/roles/assign
   * 
   * Assign or change a user's role
   * 
   * @requires Admin role
   * 
   * @body {object} Request body
   * @body {string} Request.body.userId - Target user ID
   * @body {string} Request.body.role - New role (admin, verifier, user)
   * 
   * @example
   * ```bash
   * curl -X POST http://localhost:3000/api/admin/roles/assign \
   *   -H "Authorization: Bearer admin-key-12345" \
   *   -H "Content-Type: application/json" \
   *   -d '{"userId": "verifier-user-1", "role": "admin"}'
   * ```
   * 
   * @returns {object} Updated user info
   */
  router.post('/roles/assign', requireUserAuth, requireAdminRole, (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const assignRequest = req.body as AssignRoleRequest

      // Validate request body
      if (!assignRequest.userId || !assignRequest.role) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'Missing required fields: userId, role',
        })
        return
      }

      const result = adminService.assignRole(user.id, user.email, assignRequest)

      res.status(200).json({
        success: true,
        message: result.message,
        data: result.user,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      res.status(400).json({
        error: 'BadRequest',
        message,
      })
    }
  })

  /**
   * POST /api/admin/keys/revoke
   * 
   * Revoke a user's API key and issue a new one
   * 
   * @requires Admin role
   * 
   * @body {object} Request body
   * @body {string} Request.body.userId - Target user ID
   * @body {string} Request.body.apiKey - API key to revoke
   * 
   * @example
   * ```bash
   * curl -X POST http://localhost:3000/api/admin/keys/revoke \
   *   -H "Authorization: Bearer admin-key-12345" \
   *   -H "Content-Type: application/json" \
   *   -d '{"userId": "verifier-user-1", "apiKey": "verifier-key-67890"}'
   * ```
   * 
   * @returns {object} Revocation confirmation
   */
  router.post('/keys/revoke', requireUserAuth, requireAdminRole, (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const revokeRequest = req.body as RevokeApiKeyRequest

      // Validate request body
      if (!revokeRequest.userId || !revokeRequest.apiKey) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'Missing required fields: userId, apiKey',
        })
        return
      }

      const result = adminService.revokeApiKey(user.id, user.email, revokeRequest)

      res.status(200).json({
        success: true,
        message: result.message,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      res.status(400).json({
        error: 'BadRequest',
        message,
      })
    }
  })

  /**
   * GET /api/admin/audit-logs
   * 
   * Retrieve audit logs with optional filtering
   * 
   * Query parameters:
   * - action: Filter by action type (LIST_USERS, ASSIGN_ROLE, REVOKE_API_KEY, etc.)
   * - adminId: Filter by admin ID
   * - targetUserId: Filter by target user ID
   * - status: Filter by status (success, failure)
   * - limit: Results per page (default: 50, max: 100)
   * - offset: Pagination offset (default: 0)
   * 
   * @requires Admin role
   * 
   * @example
   * ```bash
   * curl -X GET 'http://localhost:3000/api/admin/audit-logs?action=ASSIGN_ROLE&limit=20' \
   *   -H "Authorization: Bearer admin-key-12345"
   * ```
   * 
   * @returns {object} Array of audit log entries
   */
  router.get('/audit-logs', requireUserAuth, requireAdminRole, (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!

      // Parse pagination
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
      const offset = parseInt(req.query.offset as string) || 0

      if (limit < 1 || offset < 0) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'Invalid pagination parameters',
        })
        return
      }

      // Build filter object from query params
      const filters: any = {}
      if (req.query.action) filters.action = req.query.action
      if (req.query.adminId) filters.adminId = req.query.adminId
      if (req.query.targetUserId) filters.targetUserId = req.query.targetUserId
      if (req.query.status) filters.status = req.query.status

      const result = adminService.getAuditLogs(user.id, user.email, filters, limit, offset)

      res.status(200).json({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      res.status(500).json({
        error: 'InternalError',
        message,
      })
    }
  })

  return router
}
