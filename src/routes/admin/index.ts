import { Router, Request, Response, NextFunction } from "express";
import {
  AuthenticatedRequest,
  requireUserAuth,
  requireAdminRole,
  UserRole,
} from "../../middleware/auth.js";
import erasureProofRouter from './erasureProof.js'
import {
  buildPaginationMeta,
  parsePaginationParams,
} from "../../lib/pagination.js";
import { AdminService } from "../../services/admin/index.js";
import { auditLogService } from "../../services/audit/index.js";
import { impersonationService } from "../../services/impersonation/index.js";
import { AppError, ErrorCode, ValidationError } from "../../lib/errors.js";
import type {
  AssignRoleRequest,
  RevokeApiKeyRequest,
} from "../../services/admin/types.js";
import type { IssueImpersonationTokenRequest } from "../../services/impersonation/types.js";
import { ReplayService } from "../../services/replayService.js";
import { withReplaySnapshot } from "../../db/transaction.js";
import { RequestSnapshotsRepository } from "../../db/repositories/requestSnapshotsRepository.js";
import { FailedInboundEventsRepository } from "../../db/repositories/failedInboundEventsRepository.js";
import { registerAllReplayHandlers } from "../../services/replayHandlers.js";
import { IdentityRepository } from "../../db/repositories/identityRepository.js";
import { BondsRepository } from "../../db/repositories/bondsRepository.js";
import { pool } from "../../db/pool.js";

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
  registerAllReplayHandlers(replayService, identityRepo, bondsRepo);

  /**
   * GET /api/admin/users
   */
  router.get('/users', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const requestId = (req as any).requestId

      const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>, { defaultLimit: 50 })

      // Parse filter parameters
      const filters: any = {}
      if (req.query.role) {
        const validRoles = Object.values(UserRole)
        if (!validRoles.includes(req.query.role as UserRole)) {
          throw new ValidationError(`Invalid role: ${req.query.role}`)
        }
        filters.role = req.query.role
      }

      // Get users
      const result = await adminService.listUsers(
        user.id,
        user.email,
        { page, limit, offset },
        filters,
        requestId
      );

      res.status(200).json({
        success: true,
        data: {
          ...result,
          ...buildPaginationMeta(result.total, page, limit),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/admin/roles/assign
   */
  router.post('/roles/assign', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const requestId = (req as any).requestId
      const assignRequest = req.body as AssignRoleRequest

        const result = await adminService.assignRole(user.id, user.email, assignRequest as AssignRoleRequest)

        res.status(200).json({
          success: true,
          message: result.message,
          data: result.user,
        })
      } catch (error) {
        next(error)
      }

      const result = await adminService.assignRole(
        user.id,
        user.email,
        assignRequest,
        requestId
      );

      res.status(200).json({
        success: true,
        message: result.message,
        data: result.user,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/admin/keys/revoke
   */
  router.post('/keys/revoke', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const requestId = (req as any).requestId
      const revokeRequest = req.body as RevokeApiKeyRequest

        const result = await adminService.revokeApiKey(user.id, user.email, revokeRequest as RevokeApiKeyRequest)

        res.status(200).json({
          success: true,
          message: result.message,
        })
      } catch (error) {
        next(error)
      }

      const result = await adminService.revokeApiKey(
        user.id,
        user.email,
        revokeRequest,
        requestId
      );

      res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/admin/impersonate
   *
   * Issue a short-lived impersonation token for support/debug purposes.
   */
  router.post('/impersonate', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!
      const requestId = (req as any).requestId
      const body = req.body as Partial<IssueImpersonationTokenRequest>

        const issued = impersonationService.issueToken(
          user.id,
          user.email,
          body as IssueImpersonationTokenRequest,
          req.ip,
        )

      const issued = await impersonationService.issueToken(
        user.id,
        user.email,
        user.tenantId,
        {
          targetUserId: body.targetUserId,
          reason: body.reason,
          ttlSeconds: body.ttlSeconds,
        },
        req.ip,
        requestId
      );

      res.status(201).json({ success: true, data: issued });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      if (/User not found/i.test(message)) {
        res.status(404).json({ error: "NotFound", message });
        return;
      }
      res.status(400).json({ error: "BadRequest", message });
    }
  });

  /**
   * POST /api/admin/impersonate/:tokenId/revoke
   *
   * Revoke an active impersonation token.
   */
  router.post('/impersonate/:tokenId/revoke', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    const authReq = req as AuthenticatedRequest
    const user = authReq.user!
    const requestId = (req as any).requestId
    const { tokenId } = req.params

    if (!tokenId) {
      res.status(400).json({ error: 'InvalidRequest', message: 'tokenId is required' })
      return
    }

    try {
      await impersonationService.revokeToken(user.id, user.email, user.tenantId, tokenId, req.ip, requestId)
      res.status(200).json({ success: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      if (/Token not found/i.test(message)) {
        res.status(404).json({ error: 'NotFound', message })
        return
      }
      res.status(400).json({ error: "BadRequest", message });
    }
  });

  /**
   * GET /api/admin/audit-logs
   */
  router.get('/audit-logs', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    try {
      const authReq = req as AuthenticatedRequest
      const user = authReq.user!

      const { limit, cursor } = parsePaginationParams(req.query as Record<string, unknown>, { defaultLimit: 50 })

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

      const result = await adminService.getAuditLogs(user.id, user.email, filters, limit, cursor ?? undefined, user)

      // Use buildCursorPaginationMeta from lib/pagination
      const { buildCursorPaginationMeta } = await import('../../lib/pagination.js')

      res.status(200).json({
        success: true,
        data: {
          logs: result.logs,
          ...buildCursorPaginationMeta(result.hasNextPage, limit, result.nextCursor),
        },
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * GET /api/admin/audit-logs/export
   */
  router.get(
    "/audit-logs/export",
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response, next) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const user = authReq.user!;
        const requestId = (req as any).requestId

        if (!req.query.startDate || !req.query.endDate) {
          throw new ValidationError(
            "Missing required query parameters: startDate, endDate",
          );
        }

      const startDate = new Date(req.query.startDate as string);
      const endDate = new Date(req.query.endDate as string);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw new ValidationError('Invalid date format. Use ISO strings.')
      }

      if (startDate > endDate) {
        throw new ValidationError('startDate must be before or equal to endDate')
      }

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
      };
      res.write(JSON.stringify(metadata) + "\n");

      const stream = adminService.exportAuditLogs(
        user.id,
        user.email,
        startDate,
        endDate,
        user,
        requestId
      );

      let count = 0;
      for await (const log of stream) {
        res.write(JSON.stringify(log) + "\n");
        count++;
      }

      adminService.logExportCompletion(
        user.id,
        user.email,
        startDate,
        endDate,
        count,
        requestId
      );
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        next(error);
      } else {
        res.end();
      }
    }
  });

  /**
   * GET /api/admin/events/failed
   *
   * List failed inbound events for review
   */
  router.get('/events/failed', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    try {
      const authReq = req as AuthenticatedRequest
      const admin = authReq.user!
      const requestId = (req as any).requestId
      const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>)
      const filters: any = {}
      if (req.query.status) filters.status = req.query.status
      if (req.query.type) filters.type = req.query.type

      // Log the list action
      void auditLogService.logAction(
        admin.tenantId,
        admin.id,
        admin.email,
        AuditAction.LIST_FAILED_EVENTS,
        admin.id,
        undefined,
        { filters, limit, offset },
        undefined,
        undefined,
        req.ip,
        requestId
      )

      const { events, total } = await replayService.listFailedEvents(filters, limit, offset)
      const paginationMeta = buildPaginationMeta(total, page, limit)

      res.status(200).json({
        success: true,
        data: events,
        ...paginationMeta,
      })
    } catch (error: any) {
      next(error)
    }
  })

  /**
   * POST /api/admin/events/replay/:id
   *
   * Replay a specific failed event
   */
  router.post('/events/replay/:id', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    try {
      const authReq = req as AuthenticatedRequest
      const admin = authReq.user!
      const id = req.params.id
      const requestId = (req as any).requestId

      const result = await replayService.replayEvent(
        id,
        admin.id,
        admin.email,
        admin.tenantId,
        req.ip,
        requestId
      )

      res.status(200).json(result)
    } catch (error: any) {
      next(error)
    }
  })

  /**
   * POST /api/admin/replay
   * Replays a request by requestId against captured snapshot and returns diff.
   */
  router.post('/replay', requireUserAuth, requireAdminRole, async (req: Request, res: Response, next) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const admin = authReq.user!;
      const requestId = (req as any).requestId;
      const { requestId: targetRequestId } = req.body as { requestId: string };
      if (!targetRequestId) {
        throw new ValidationError('Missing requestId');
      }

      // Log the replay request
      void auditLogService.logAction(
        admin.tenantId,
        admin.id,
        admin.email,
        AuditAction.REPLAY_REQUEST,
        targetRequestId,
        undefined,
        { requestId: targetRequestId },
        undefined,
        undefined,
        req.ip,
        requestId
      );

      const diff = await withReplaySnapshot(pool, async (client, snapshot) => {
        const identityRepo = new IdentityRepository(client);
        const bondsRepo = new BondsRepository(client);
        const currentIdentities = await identityRepo.findAll();
        const currentBonds = await bondsRepo.findAll();
        const computeDiff = (current: any, previous: any) => {
          const diffResult: any = { added: [], removed: [], changed: [] };
          const currentMap = new Map(current.map((item: any) => [item.id, item]));
          const prevMap = new Map(previous.map((item: any) => [item.id, item]));
          for (const [id, cur] of currentMap) {
            if (!prevMap.has(id)) diffResult.added.push(cur);
            else if (JSON.stringify(cur) !== JSON.stringify(prevMap.get(id))) diffResult.changed.push({ before: prevMap.get(id), after: cur });
          }
          for (const [id, prev] of prevMap) {
            if (!currentMap.has(id)) diffResult.removed.push(prev);
          }
          return diffResult;
        };
        const identitiesDiff = computeDiff(currentIdentities, snapshot.identities);
        const bondsDiff = computeDiff(currentBonds, snapshot.bonds);
        return { identities: identitiesDiff, bonds: bondsDiff };
      }, targetRequestId);
      res.status(200).json({ success: true, data: diff });
    } catch (error) {
      next(error);
    }
  });

  // Mount erasure-proof sub-routes
  router.use(erasureProofRouter)

  return router
}
