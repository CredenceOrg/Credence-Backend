import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../../db/pool.js'
import { OutboxRepository } from '../../db/outbox/repository.js'
import type { OutboxQuarantineEntry, OutboxQuarantineReason } from '../../db/outbox/types.js'
import { buildPaginationMeta, parsePaginationParams } from '../../lib/pagination.js'
import {
  ApiScope,
  AuthenticatedRequest,
  requireAdminRole,
  requireApiKey,
  requireUserAuth,
} from '../../middleware/auth.js'
import { auditLogService } from '../../services/audit/index.js'

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
        const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>, {
          defaultLimit: 50,
        })
        const reason = typeof req.query.reason === 'string' ? req.query.reason : undefined
        if (reason && !quarantineReasons.has(reason as OutboxQuarantineReason)) {
          res.status(400).json({ error: 'InvalidReason', message: `Unsupported quarantine reason: ${reason}` })
          return
        }

        const { entries, total } = await repository.listQuarantine(
          pool,
          limit,
          offset,
          reason as OutboxQuarantineReason | undefined
        )

        res.status(200).json({
          success: true,
          data: entries.map(serializeEntry),
          ...buildPaginationMeta(total, page, limit),
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
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          res.status(400).json({ error: 'InvalidPayload', message: 'payload must be a JSON object' })
          return
        }

        const apiKey = (req as AuthenticatedRequest).apiKey as { key?: string } | undefined
        const actorId = apiKey?.key ?? 'api-key'
        const actorEmail = 'api-key@credence.local'
        const tenantId = 'system'

        const newEventId = await repository.reinjectQuarantined(pool, id, payload as Record<string, unknown>, actorId)
        if (!newEventId) {
          res.status(404).json({ error: 'NotFound', message: 'Quarantined event not found or already reinjected' })
          return
        }

        await auditLogService.logAction({
          tenantId,
          actorId,
          actorEmail,
          action: 'OUTBOX_REINJECT',
          resourceType: 'outbox_quarantine',
          resourceId: id.toString(),
          details: {
            quarantineId: id.toString(),
            newOutboxEventId: newEventId.toString(),
          },
          status: 'success',
          ipAddress: req.ip,
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

  return router
}
