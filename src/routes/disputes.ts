import { Router, type Request, type Response } from 'express'
import { type AuthenticatedRequest, requireUserAuth } from '../middleware/auth.js'
import { ErrorCode, getErrorCatalogEntry } from '../lib/errorCatalog.js'
import {
  dismissDispute,
  getDispute,
  markUnderReview,
  resolveDispute,
  submitDispute,
  listDisputes,
} from '../services/governance/disputes.js'
import {
  parsePaginationParams,
  buildCursorEnvelope,
  encodeCursor,
  MAX_LIMIT,
  PaginationValidationError,
} from '../lib/pagination.js'
import { DISPUTE_STATES } from '../services/governance/disputeStateMachine.js'
import type { DisputeStatus } from '../services/governance/types.js'
import { auditLogService, AuditAction } from '../services/audit/index.js'

const router = Router()

function invalidTransitionResponse(message: string) {
  const catalog = getErrorCatalogEntry(ErrorCode.INVALID_DISPUTE_TRANSITION)
  return {
    error: catalog.defaultMessage,
    code: catalog.code,
    error_code: catalog.code,
    message,
  }
}

router.post('/', requireUserAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!

  try {
    const dispute = submitDispute(req.body, actor.tenantId)

    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_SUBMITTED,
      resourceType: 'dispute',
      resourceId: dispute.id,
      details: {
        filedBy: dispute.filedBy,
        respondent: dispute.respondent,
        evidenceCount: dispute.evidence.length,
      },
    })

    res.status(201).json(dispute)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_SUBMITTED,
      resourceType: 'dispute',
      resourceId: 'unknown',
      details: { body: req.body },
      status: 'failure',
      errorMessage: message,
    })
    res.status(400).json({ error: 'BadRequest', message })
  }
})

router.get('/', requireUserAuth, (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!

  const status = req.query.status as string | undefined
  if (status && !DISPUTE_STATES.includes(status as any)) {
    res.status(400).json({ error: 'BadRequest', message: `Invalid status: ${status}` })
    return
  }

  let pag
  try {
    pag = parsePaginationParams(req.query, { maxLimit: MAX_LIMIT })
  } catch (error) {
    if (error instanceof PaginationValidationError) {
      res.status(400).json({ error: 'BadRequest', message: error.details[0]?.message || 'Invalid pagination parameters' })
      return
    }
    res.status(400).json({ error: 'BadRequest', message: 'Invalid pagination parameters' })
    return
  }

  const result = listDisputes(
    { tenantId: actor.tenantId, status: status as DisputeStatus },
    { limit: pag.limit, cursor: pag.decodedCursor }
  )

  const envelope = buildCursorEnvelope(result.data, {
    limit: pag.limit,
    hasMore: result.hasMore,
    nextCursor: result.hasMore && result.data.length > 0
      ? encodeCursor(result.data[result.data.length - 1].createdAt, result.data[result.data.length - 1].id)
      : null,
  })

  res.status(200).json(envelope)
})

router.get('/:id', requireUserAuth, (req: Request, res: Response) => {
  const dispute = getDispute(req.params.id)
  if (!dispute) {
    res.status(404).json({ error: 'NotFound', message: 'Dispute not found' })
    return
  }

  res.status(200).json(dispute)
})

router.post('/:id/review', requireUserAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!
  const id = req.params.id

  try {
    const dispute = markUnderReview(id)

    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_MARKED_UNDER_REVIEW,
      resourceType: 'dispute',
      resourceId: id,
      details: { status: dispute.status },
    })

    res.status(200).json(dispute)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_MARKED_UNDER_REVIEW,
      resourceType: 'dispute',
      resourceId: id,
      details: {},
      status: 'failure',
      errorMessage: message,
    })
    res.status(getErrorCatalogEntry(ErrorCode.INVALID_DISPUTE_TRANSITION).httpStatus!).json(
      invalidTransitionResponse(message),
    )
  }
})

router.post('/:id/resolve', requireUserAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!
  const id = req.params.id
  const { resolution } = req.body as { resolution: string }

  try {
    const dispute = resolveDispute(id, resolution)

    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_RESOLVED,
      resourceType: 'dispute',
      resourceId: id,
      details: { resolution },
    })

    res.status(200).json(dispute)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_RESOLVED,
      resourceType: 'dispute',
      resourceId: id,
      details: { resolution },
      status: 'failure',
      errorMessage: message,
    })
    res.status(getErrorCatalogEntry(ErrorCode.INVALID_DISPUTE_TRANSITION).httpStatus!).json(
      invalidTransitionResponse(message),
    )
  }
})

router.post('/:id/dismiss', requireUserAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!
  const id = req.params.id
  const { reason } = req.body as { reason: string }

  try {
    const dispute = dismissDispute(id, reason)

    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_DISMISSED,
      resourceType: 'dispute',
      resourceId: id,
      details: { reason },
    })

    res.status(200).json(dispute)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_DISMISSED,
      resourceType: 'dispute',
      resourceId: id,
      details: { reason },
      status: 'failure',
      errorMessage: message,
    })
    res.status(getErrorCatalogEntry(ErrorCode.INVALID_DISPUTE_TRANSITION).httpStatus!).json(
      invalidTransitionResponse(message),
    )
  }
})

export default router
