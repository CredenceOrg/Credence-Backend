import { Router, Request, Response } from 'express'
import { AuthenticatedRequest, requireUserAuth, requireAdminRole, UserRole } from '../../middleware/auth.js'
import {
  buildPaginationMeta,
  parsePaginationParams,
} from '../../lib/pagination.js'
import { AdminService } from '../../services/admin/index.js'
import { auditLogService } from '../../services/audit/index.js'
import { AppError, ErrorCode, ValidationError } from '../../lib/errors.js'
import type { AssignRoleRequest, RevokeApiKeyRequest } from '../../services/admin/types.js'
import type { IssueImpersonationTokenRequest } from '../../services/impersonation/types.js'
import { ReplayService } from '../../services/replayService.js'
import { FailedInboundEventsRepository } from '../../db/repositories/failedInboundEventsRepository.js'
import { registerAllReplayHandlers } from '../../services/replayHandlers.js'
import { IdentityRepository } from '../../db/repositories/identityRepository.js'
import { BondsRepository } from '../../db/repositories/bondsRepository.js'
import { pool } from '../../db/pool.js'

/**
 * Create the admin router with role and user management endpoints
 * All endpoints require admin authentication
 */
export function createAdminRouter(): Router {
  const router = Router()
  const adminService = new AdminService(auditLogService)
  
  // Replay Service Setup
  const replayRepo = new FailedInboundEventsRepository(pool)
  const replayService = new ReplayService(replayRepo)
  
  const identityRepo = new IdentityRepository(pool)
  const bondsRepo = new BondsRepository(pool)
  
  // Register handlers
  registerAllReplayHandlers(replayService, identityRepo, bondsRepo)

  /**
   * GET /api/admin/users
   */
  router.get('/users', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!

      const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>, { defaultLimit: 50 })

      // Parse filter parameters
      const filters: any = {}
      if (req.query.role) {
        const validRoles = Object.values(UserRole)
        if (!validRoles.includes(req.query.role as UserRole)) {
          throw new ValidationError(`Invalid role: ${req.query.role}`)
        }
        filters.role = req.query.role as UserRole
      }
      if (req.query.active !== undefined) {
        filters.active = req.query.active === 'true'
      }

      // Get users
      const result = await adminService.listUsers(user.id, user.email, { page, limit, offset }, filters)

      res.status(200).json({
        success: true,
        data: {
          ...result,
          ...buildPaginationMeta(result.total, page, limit),
        },
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/admin/roles/assign
   */
  router.post('/roles/assign', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const assignRequest = req.body as AssignRoleRequest

      // Validate request body
      if (!assignRequest.userId || !assignRequest.role) {
        throw new ValidationError('Missing required fields: userId, role')
      }

      const result = await adminService.assignRole(user.id, user.email, assignRequest)

      res.status(200).json({
        success: true,
        message: result.message,
        data: result.user,
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/admin/keys/revoke
   */
  router.post('/keys/revoke', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const revokeRequest = req.body as RevokeApiKeyRequest

      // Validate request body
      if (!revokeRequest.userId || !revokeRequest.apiKey) {
        throw new ValidationError('Missing required fields: userId, apiKey')
      }

      const result = await adminService.revokeApiKey(user.id, user.email, revokeRequest)

      res.status(200).json({
        success: true,
        message: result.message,
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/admin/impersonate
   *
   * Issue a short-lived impersonation token for support/debug purposes.
   */
  router.post('/impersonate', requireUserAuth, requireAdminRole, (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const body = req.body as Partial<IssueImpersonationTokenRequest>

      if (!body.targetUserId) {
        res.status(400).json({ error: 'InvalidRequest', message: 'targetUserId is required' })
        return
      }
      if (!body.reason) {
        res.status(400).json({ error: 'InvalidRequest', message: 'reason is required' })
        return
      }

      const issued = impersonationService.issueToken(
        user.id,
        user.email,
        {
          targetUserId: body.targetUserId,
          reason: body.reason,
          ttlSeconds: body.ttlSeconds,
        },
        req.ip,
      )

      res.status(201).json({ success: true, data: issued })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      if (/User not found/i.test(message)) {
        res.status(404).json({ error: 'NotFound', message })
        return
      }
      res.status(400).json({ error: 'BadRequest', message })
    }
  })

  /**
   * POST /api/admin/impersonate/:tokenId/revoke
   *
   * Revoke an active impersonation token.
   */
  router.post('/impersonate/:tokenId/revoke', requireUserAuth, requireAdminRole, (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest
    const user = authReq.user!
    const { tokenId } = req.params

    if (!tokenId) {
      res.status(400).json({ error: 'InvalidRequest', message: 'tokenId is required' })
      return
    }

    try {
      impersonationService.revokeToken(user.id, user.email, tokenId, req.ip)
      res.status(200).json({ success: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      if (/Token not found/i.test(message)) {
        res.status(404).json({ error: 'NotFound', message })
        return
      }
      res.status(400).json({ error: 'BadRequest', message })
    }
  })

  /**
   * GET /api/admin/audit-logs
   */
  router.get('/audit-logs', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!

      const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>, { defaultLimit: 50 })

      // Build filter object from query params
      const filters: any = {}
      if (req.query.action) filters.action = req.query.action
      if (req.query.adminId) filters.adminId = req.query.adminId
      if (req.query.actorId) filters.actorId = req.query.actorId
      if (req.query.targetUserId) filters.targetUserId = req.query.targetUserId
      if (req.query.resourceId) filters.resourceId = req.query.resourceId
      if (req.query.resourceType) filters.resourceType = req.query.resourceType
      if (req.query.status) filters.status = req.query.status
      if (req.query.from) filters.from = req.query.from
      if (req.query.to) filters.to = req.query.to

      const result = await adminService.getAuditLogs(user.id, user.email, filters, limit, offset)

      res.status(200).json({
        success: true,
        data: {
          ...result,
          ...buildPaginationMeta(result.total, page, limit),
        },
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * GET /api/admin/audit-logs/export
   */
  router.get('/audit-logs/export', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!

      if (!req.query.startDate || !req.query.endDate) {
        throw new ValidationError('Missing required query parameters: startDate, endDate')
      }

      const startDate = new Date(req.query.startDate as string)
      const endDate = new Date(req.query.endDate as string)

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw new ValidationError('Invalid date format. Use ISO strings.')
      }
      
      if (startDate > endDate) {
        throw new ValidationError('startDate must be before or equal to endDate')
      }

      const stream = adminService.exportAuditLogs(user.id, user.email, startDate, endDate, user)

      // Set headers for NDJSON streaming
      res.setHeader('Content-Type', 'application/x-ndjson')
      res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.ndjson"')
      
      const metadata = {
        _meta: {
          exportedAt: new Date().toISOString(),
          exportedBy: user.email,
          dateRange: { start: startDate.toISOString(), end: endDate.toISOString() },
          schemaVersion: "1.0"
        }
      }
      res.write(JSON.stringify(metadata) + '\n')

      let count = 0
      for await (const log of stream) {
        res.write(JSON.stringify(log) + '\n')
        count++
      }

      adminService.logExportCompletion(user.id, user.email, startDate, endDate, count)
      res.end()
    } catch (error) {
      if (!res.headersSent) {
        next(error)
      } else {
        res.end()
      }
    }
  })

  /**
   * GET /api/admin/events/failed
   * 
   * List failed inbound events for review
   */
  router.get('/events/failed', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const filters: any = {}
      if (req.query.status) filters.status = req.query.status
      if (req.query.type) filters.type = req.query.type

      const limit = parseInt(req.query.limit as string) || 50
      const offset = parseInt(req.query.offset as string) || 0

      const result = await replayService.listFailedEvents(filters, limit, offset)
      
      res.status(200).json({
        success: true,
        data: result
      })
    } catch (error: any) {
      res.status(500).json({ error: 'InternalError', message: error.message })
    }
  })

  /**
   * POST /api/admin/events/replay/:id
   * 
   * Replay a specific failed event
   */
  router.post('/events/replay/:id', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const admin = authReq.user!
      const id = req.params.id

      const result = await replayService.replayEvent(
        id,
        admin.id,
        admin.email,
        req.ip
      )

      res.status(200).json(result)
    } catch (error: any) {
      res.status(400).json({ error: 'ReplayFailed', message: error.message })
    }
  })

  return router
}
