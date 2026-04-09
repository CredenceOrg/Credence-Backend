import { Router, type Request, type Response } from 'express'
import { type AuthenticatedRequest, requireUserAuth } from '../middleware/auth.js'
import {
  dismissDispute,
  getDispute,
  markUnderReview,
  resolveDispute,
  submitDispute,
} from '../services/governance/disputes.js'
import { auditLogService, AuditAction } from '../services/audit/index.js'

const router = Router()

router.post('/', requireUserAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!

  try {
    const dispute = submitDispute(req.body)

    await auditLogService.logAction({
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
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_MARKED_UNDER_REVIEW,
      resourceType: 'dispute',
      resourceId: id,
      details: {},
      status: 'failure',
      errorMessage: message,
    })
    res.status(409).json({ error: 'Conflict', message })
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
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_RESOLVED,
      resourceType: 'dispute',
      resourceId: id,
      details: { resolution },
      status: 'failure',
      errorMessage: message,
    })
    res.status(409).json({ error: 'Conflict', message })
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
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.DISPUTE_DISMISSED,
      resourceType: 'dispute',
      resourceId: id,
      details: { reason },
      status: 'failure',
      errorMessage: message,
    })
    res.status(409).json({ error: 'Conflict', message })
  }
})

export default router
