import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../../db/pool.js'
import { OutboxRepository } from '../../db/outbox/repository.js'
import type { OutboxQuarantineEntry, OutboxQuarantineReason } from '../../db/outbox/types.js'
import { buildPaginationLinks, buildPaginationMeta, parsePaginationParams } from '../../lib/pagination.js'
import {
  ApiScope,
  AuthenticatedRequest,
  requireAdminRole,
  requireApiKey,
  requireUserAuth,
} from '../../middleware/auth.js'
import { auditLogService, AuditAction } from '../../services/audit/index.js'
import { sendError, ErrorCode } from '../../lib/errors.js'
import {
  setOutboxPublisherRunning,
  getOutboxPublisherState,
} from '../../services/health/runtimeState.js'

const quarantineReasons = new Set<OutboxQuarantineReason>([
  'malformed_json',
  'schema_invalid',
  'oversized_payload',
  'unknown_event_type',
])

function serializeBigInt(value: bigint): string {
  return value.toString()
}

function serializeEntry(entry: OutboxQuarantineEntry) {
  return {
    id: serializeBigInt(entry.id),
    originalEventId: serializeBigInt(entry.originalEventId),
    aggregateType: entry.aggregateType,
    aggregateId: entry.aggregateId,
    eventType: entry.eventType,
    payload: entry.payload,
    reason: entry.reason,
    errorMessage: entry.errorMessage,
    retryCount: entry.retryCount,
    maxRetries: entry.maxRetries,
    quarantinedAt: entry.quarantinedAt.toISOString(),
    reinjectedAt: entry.reinjectedAt?.toISOString() ?? null,
    reinjectedBy: entry.reinjectedBy,
  }
}

export function createOutboxAdminRouter(repository = new OutboxRepository()): Router {
  const router = Router()

  router.get(
    '/quarantine',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest
        const admin = authReq.user!
        const requestId = (req as any).requestId
        const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>, {
          defaultLimit: 50,
        })
        const reason = typeof req.query.reason === 'string' ? req.query.reason : undefined
        if (reason && !quarantineReasons.has(reason as OutboxQuarantineReason)) {
          sendError(res, ErrorCode.VALIDATION_FAILED, `Unsupported quarantine reason: ${reason}`)
          return
        }

        // Log the list action
        void auditLogService.logAction(
          admin.tenantId,
          admin.id,
          admin.email,
          AuditAction.LIST_OUTBOX_QUARANTINE,
          admin.id,
          undefined,
          { reason, limit, offset },
          undefined,
          undefined,
          req.ip,
          requestId
        )

        const { entries, total } = await repository.listQuarantine(
          pool,
          limit,
          offset,
          reason as OutboxQuarantineReason | undefined
        )

        const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`

        res.status(200).json({
          success: true,
          data: entries.map(serializeEntry),
          ...buildPaginationMeta(total, page, limit),
          links: buildPaginationLinks(fullUrl, page, limit, total),
        })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/quarantine/:id/reinject',
    requireApiKey(ApiScope.OUTBOX_REINJECT),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = BigInt(req.params.id)
        const payload = req.body?.payload
        const requestId = (req as any).requestId
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          sendError(res, ErrorCode.VALIDATION_FAILED, 'payload must be a JSON object')
          return
        }

        const apiKey = (req as AuthenticatedRequest).apiKey as { key?: string } | undefined
        const actorId = apiKey?.key ?? 'api-key'
        const actorEmail = 'api-key@credence.local'
        const tenantId = 'system'

        const newEventId = await repository.reinjectQuarantined(pool, id, payload as Record<string, unknown>, actorId)
        if (!newEventId) {
          sendError(res, ErrorCode.NOT_FOUND, 'Quarantined event not found or already reinjected')
          return
        }

        await auditLogService.logAction({
          tenantId,
          actorId,
          actorEmail,
          action: AuditAction.OUTBOX_REINJECT,
          resourceType: 'outbox_quarantine',
          resourceId: id.toString(),
          details: {
            quarantineId: id.toString(),
            newOutboxEventId: newEventId.toString(),
          },
          status: 'success',
          ipAddress: req.ip,
          requestId,
        })

        res.status(201).json({
          success: true,
          data: {
            id: newEventId.toString(),
            quarantineId: id.toString(),
          },
        })
      } catch (error) {
        next(error)
      }
    }
  )

  /**
   * POST /pause
   *
   * Pause the outbox publisher. Requires admin authentication.
   * Logs an audit entry on success.
   * Uses runtime state to signal the outbox publisher to stop processing.
   *
   * This handler sets `running = false` unconditionally, so calling it
   * when already paused is a safe no-op (only the audit entry is written).
   */
  router.post(
    '/pause',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest
        const admin = authReq.user!
        const requestId = (req as any).requestId

        setOutboxPublisherRunning(false)

        await auditLogService.logAction(
          admin.tenantId,
          admin.id,
          admin.email,
          AuditAction.OUTBOX_PAUSE,
          admin.id,
          undefined,
          undefined,
          'success',
          undefined,
          req.ip,
          requestId
        )

        res.status(200).json({ success: true, message: 'Outbox publisher paused' })
      } catch (error) {
        next(error)
      }
    }
  )

  /**
   * POST /resume
   *
   * Resume the outbox publisher. Requires admin authentication.
   * Logs an audit entry on success.
   * Guards against resuming when already running to avoid redundant audit entries.
   */
  router.post(
    '/resume',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest
        const admin = authReq.user!
        const requestId = (req as any).requestId

        const state = getOutboxPublisherState()
        if (state.running) {
          res.status(409).json({ success: false, message: 'Outbox publisher is already running' })
          return
        }

        setOutboxPublisherRunning(true)

        await auditLogService.logAction(
          admin.tenantId,
          admin.id,
          admin.email,
          AuditAction.OUTBOX_RESUME,
          admin.id,
          undefined,
          undefined,
          'success',
          undefined,
          req.ip,
          requestId
        )

        res.status(200).json({ success: true, message: 'Outbox publisher resumed' })
      } catch (error) {
        next(error)
      }
    }
  )

  /**
   * GET /status
   *
   * Returns the current outbox publisher status (running/paused).
   * Requires admin authentication.
   */
  router.get(
    '/status',
    requireUserAuth,
    requireAdminRole,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const state = getOutboxPublisherState()

        res.status(200).json({
          success: true,
          data: {
            running: state.running,
            configured: state.configured,
            lastHeartbeatAt: state.lastHeartbeatAt,
          },
        })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
