import { Router, type Request, type Response } from 'express'
import { type AuthenticatedRequest, requireUserAuth } from '../middleware/auth.js'
import {
  createSlashRequest,
  getSlashRequest,
  listSlashRequests,
  submitVote,
  type VoteChoice,
} from '../services/governance/slashingVotes.js'
import { auditLogService, AuditAction } from '../services/audit/index.js'

const router = Router()

router.post('/slash-requests', requireUserAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!

  try {
    const request = createSlashRequest(req.body)

    await auditLogService.logAction({
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.SLASH_REQUEST_CREATED,
      resourceType: 'slash_request',
      resourceId: request.id,
      details: {
        requestedBy: request.requestedBy,
        targetAddress: request.targetAddress,
        reason: request.reason,
      },
    })

    res.status(201).json(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await auditLogService.logAction({
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.SLASH_REQUEST_CREATED,
      resourceType: 'slash_request',
      resourceId: 'unknown',
      details: { body: req.body },
      status: 'failure',
      errorMessage: message,
    })

    res.status(400).json({ error: 'BadRequest', message })
  }
})

router.post('/slash-requests/:id/votes', requireUserAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!
  const requestId = req.params.id
  const { voterId, choice } = req.body as { voterId: string; choice: VoteChoice }

  try {
    const result = submitVote(requestId, voterId, choice)

    if (!result) {
      res.status(404).json({ error: 'NotFound', message: 'Slash request not found' })
      return
    }

    await auditLogService.logAction({
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.SLASH_VOTE_CAST,
      resourceType: 'slash_request',
      resourceId: requestId,
      details: {
        voterId,
        choice,
        status: result.status,
        approveCount: result.approveCount,
        rejectCount: result.rejectCount,
      },
    })

    res.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await auditLogService.logAction({
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.SLASH_VOTE_CAST,
      resourceType: 'slash_request',
      resourceId: requestId,
      details: { voterId, choice },
      status: 'failure',
      errorMessage: message,
    })
    res.status(409).json({ error: 'Conflict', message })
  }
})

router.get('/slash-requests/:id', requireUserAuth, (req: Request, res: Response) => {
  const request = getSlashRequest(req.params.id)
  if (!request) {
    res.status(404).json({ error: 'NotFound', message: 'Slash request not found' })
    return
  }
  res.status(200).json(request)
})

router.get('/slash-requests', requireUserAuth, (req: Request, res: Response) => {
  const status = req.query.status as 'pending' | 'approved' | 'rejected' | undefined
  const requests = listSlashRequests(status)
  res.status(200).json({ requests })
})

export default router
