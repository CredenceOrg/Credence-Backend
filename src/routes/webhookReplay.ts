/**
 * Webhook DLQ replay routes
 *
 * Endpoints
 * ---------
 * GET  /api/webhooks/dlq              — list DLQ entries (paginated)
 * GET  /api/webhooks/dlq/:id          — fetch one DLQ entry
 * POST /api/webhooks/dlq/:id/replay   — replay a DLQ entry (audited, idempotent)
 * GET  /api/webhooks/dlq/:id/history  — replay audit history for one entry
 *
 * Authorization: all routes require WEBHOOKS_ADMIN scope.
 *
 * Rate limiting
 * -------------
 * The replay POST is subject to a dedicated rate-limit namespace so that a
 * misbehaving client cannot hammer downstream endpoints via the replay path.
 * Default: 10 replays per minute per tenant (configurable via env).
 *
 * Idempotency
 * -----------
 * Every replay POST requires an `Idempotency-Key` header.  A duplicate key
 * for the same DLQ entry returns the original 200 response immediately
 * without re-delivering the webhook.
 */

import { Router, type Request, type Response } from 'express'
import type { Pool } from 'pg'
import { requireApiKey, ApiScope, type AuthenticatedRequest } from '../middleware/auth.js'
import { createRateLimitMiddleware } from '../middleware/rateLimit.js'
import { WebhookDlqRepository } from '../repositories/webhookDlqRepository.js'
import { PostgresDlqStore } from '../services/webhooks/postgresDlqStore.js'
import { PostgresWebhookRepository } from '../db/repositories/webhookRepository.js'
import { WebhookService } from '../services/webhooks/service.js'
import { auditLogService, AuditAction } from '../services/audit/index.js'
import { sendError, ErrorCode } from '../lib/errors.js'
import { logger } from '../utils/logger.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPLAY_RATE_LIMIT_WINDOW_SEC = parseInt(
  process.env.WEBHOOK_REPLAY_RATE_LIMIT_WINDOW_SEC ?? '60',
  10,
)
const REPLAY_RATE_LIMIT_MAX = parseInt(
  process.env.WEBHOOK_REPLAY_RATE_LIMIT_MAX ?? '10',
  10,
)

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the webhook DLQ router, injecting a database pool.
 * The pool is used to construct all repository/service dependencies.
 */
export function createWebhookReplayRouter(pool: Pool): Router {
  const router = Router()

  // Repositories / services (created once per router instance)
  const dlqRepo = new WebhookDlqRepository(pool)
  const dlqStore = new PostgresDlqStore(pool)
  const webhookStore = new PostgresWebhookRepository(pool)
  const webhookService = new WebhookService(webhookStore, undefined, dlqStore, auditLogService)

  // Dedicated rate limiter for the replay endpoint
  const replayRateLimit = createRateLimitMiddleware(
    {
      enabled: true,
      windowSec: REPLAY_RATE_LIMIT_WINDOW_SEC,
      maxFree: REPLAY_RATE_LIMIT_MAX,
      maxPro: REPLAY_RATE_LIMIT_MAX,
      maxEnterprise: REPLAY_RATE_LIMIT_MAX,
      failOpen: true, // Don't block replays if Redis is unavailable
    },
    {
      namespace: 'ratelimit:webhook_replay',
      windowSec: REPLAY_RATE_LIMIT_WINDOW_SEC,
    },
  )

  // ── GET /api/webhooks/dlq ─────────────────────────────────────────────────

  router.get(
    '/',
    requireApiKey(ApiScope.WEBHOOKS_ADMIN),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10), 500)
        const pendingOnly = req.query.pending === 'true'
        const beforeId = typeof req.query.before === 'string' ? req.query.before : undefined

        const entries = await dlqRepo.list({ limit, pendingOnly, beforeId })
        res.json({ data: entries, count: entries.length })
      } catch (err) {
        logger.error({ err }, '[webhookReplay] Failed to list DLQ entries')
        sendError(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Failed to list DLQ entries')
      }
    },
  )

  // ── GET /api/webhooks/dlq/:id ─────────────────────────────────────────────

  router.get(
    '/:id',
    requireApiKey(ApiScope.WEBHOOKS_ADMIN),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const entry = await dlqRepo.findById(req.params.id)
        if (!entry) {
          sendError(res, ErrorCode.NOT_FOUND, `DLQ entry ${req.params.id} not found`)
          return
        }
        res.json({ data: entry })
      } catch (err) {
        logger.error({ err }, '[webhookReplay] Failed to fetch DLQ entry')
        sendError(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Failed to fetch DLQ entry')
      }
    },
  )

  // ── GET /api/webhooks/dlq/:id/history ────────────────────────────────────

  router.get(
    '/:id/history',
    requireApiKey(ApiScope.WEBHOOKS_ADMIN),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const history = await dlqRepo.getReplayHistory(req.params.id)
        res.json({ data: history, count: history.length })
      } catch (err) {
        logger.error({ err }, '[webhookReplay] Failed to fetch replay history')
        sendError(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Failed to fetch replay history')
      }
    },
  )

  // ── POST /api/webhooks/dlq/:id/replay ────────────────────────────────────

  router.post(
    '/:id/replay',
    requireApiKey(ApiScope.WEBHOOKS_ADMIN),
    replayRateLimit,
    async (req: Request, res: Response): Promise<void> => {
      // 1. Require Idempotency-Key header
      const idempotencyKey = req.headers['idempotency-key']
      if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
        sendError(
          res,
          ErrorCode.VALIDATION_FAILED,
          'Missing required header: Idempotency-Key',
        )
        return
      }

      const dlqEntryId = req.params.id
      const authReq = req as AuthenticatedRequest
      const actor = authReq.user ?? {
        id: (authReq.apiKey?.ownerId ?? 'unknown'),
        email: 'api-key@system',
        tenantId: 'system',
        role: 'admin' as any,
      }
      const ipAddress = req.socket?.remoteAddress ?? 'unknown'
      const requestId = req.headers['x-request-id'] as string | undefined

      // 2. Fetch the DLQ entry
      const entry = await dlqRepo.findById(dlqEntryId).catch((err: unknown) => {
        logger.error({ err }, '[webhookReplay] DB error fetching DLQ entry')
        sendError(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Failed to fetch DLQ entry')
        return undefined
      })

      if (entry === undefined) return // sendError already called above

      if (!entry) {
        sendError(res, ErrorCode.NOT_FOUND, `DLQ entry ${dlqEntryId} not found`)
        return
      }

      // 3. Idempotency check — if this key was already processed, return
      //    the original outcome without re-delivering.
      const existing = await dlqRepo
        .findByIdempotencyKey(dlqEntryId, idempotencyKey)
        .catch(() => null)

      if (existing) {
        logger.info(
          { dlqEntryId, idempotencyKey, actor: actor.id },
          '[webhookReplay] Idempotent replay — returning cached result',
        )
        res.setHeader('X-Idempotent-Replay', 'true')
        res.json({
          replayed: false,
          idempotent: true,
          dlqEntryId,
          success: existing.success,
          statusCode: existing.status_code,
          replayedAt: existing.replayed_at,
        })
        return
      }

      // 4. Perform the replay via WebhookService (handles DLQ markReplayed internally)
      let deliveryResult: Awaited<ReturnType<WebhookService['replayWebhook']>>
      try {
        deliveryResult = await webhookService.replayWebhook(dlqEntryId, {
          id: actor.id,
          email: actor.email,
          tenantId: actor.tenantId,
        }, requestId)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ err, dlqEntryId }, '[webhookReplay] Replay delivery failed')

        // Record failure in audit table regardless
        await dlqRepo
          .recordReplay({
            dlqEntryId,
            webhookId: entry.webhookId,
            actorId: actor.id,
            actorEmail: actor.email,
            tenantId: actor.tenantId,
            idempotencyKey,
            success: false,
            errorMessage: message,
            ipAddress,
            requestId,
          })
          .catch(() => { /* best-effort */ })

        // Also emit to the AuditLog service
        void auditLogService.logAction({
          tenantId: actor.tenantId,
          actorId: actor.id,
          actorEmail: actor.email,
          action: AuditAction.REPLAY_WEBHOOK,
          resourceType: 'webhook_dlq',
          resourceId: dlqEntryId,
          details: { webhookId: entry.webhookId, success: false, error: message },
          status: 'failure',
          errorMessage: message,
          ipAddress,
          requestId,
        })

        sendError(res, ErrorCode.INTERNAL_SERVER_ERROR, `Replay failed: ${message}`)
        return
      }

      // 5. Record the audit row (idempotent via ON CONFLICT DO NOTHING)
      await dlqRepo
        .recordReplay({
          dlqEntryId,
          webhookId: entry.webhookId,
          actorId: actor.id,
          actorEmail: actor.email,
          tenantId: actor.tenantId,
          idempotencyKey,
          success: deliveryResult.success,
          statusCode: deliveryResult.statusCode,
          errorMessage: deliveryResult.error,
          ipAddress,
          requestId,
        })
        .catch((err: unknown) => {
          // Non-fatal: audit write failed but delivery succeeded
          logger.error({ err }, '[webhookReplay] Failed to write replay audit row')
        })

      // 6. Emit AuditAction.REPLAY_WEBHOOK to the structured audit log service
      void auditLogService.logAction({
        tenantId: actor.tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: AuditAction.REPLAY_WEBHOOK,
        resourceType: 'webhook_dlq',
        resourceId: dlqEntryId,
        details: {
          webhookId: entry.webhookId,
          success: deliveryResult.success,
          statusCode: deliveryResult.statusCode,
        },
        status: deliveryResult.success ? 'success' : 'failure',
        errorMessage: deliveryResult.error,
        ipAddress,
        requestId,
      })

      logger.info(
        {
          dlqEntryId,
          webhookId: entry.webhookId,
          success: deliveryResult.success,
          actor: actor.id,
        },
        '[webhookReplay] Replay complete',
      )

      res.json({
        replayed: true,
        idempotent: false,
        dlqEntryId,
        webhookId: entry.webhookId,
        success: deliveryResult.success,
        statusCode: deliveryResult.statusCode,
        attempts: deliveryResult.attempts,
        error: deliveryResult.error,
      })
    },
  )

  return router
}
