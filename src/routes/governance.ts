import { Router, type Request, type Response } from 'express'
import { type AuthenticatedRequest, requireUserAuth } from '../middleware/auth.js'
import {
  createSlashRequest,
  getSlashRequest,
  listSlashRequests,
  submitVote,
} from '../services/governance/slashingVotes.js'
import { auditLogService, AuditAction } from '../services/audit/index.js'
import {
  buildPaginationMeta,
  parsePaginationParams,
} from '../lib/pagination.js'
import { validate, type ValidatedRequest } from '../middleware/validate.js'
import {
  createSlashRequestBodySchema,
  submitVoteBodySchema,
  slashRequestIdParamsSchema,
  type CreateSlashRequestBody,
  type SubmitVoteBody,
  type SlashRequestIdParams,
} from '../schemas/governance.js'

const router = Router()

router.post(
  '/slash-requests',
  requireUserAuth,
  validate({ body: createSlashRequestBodySchema }),
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest
    const actor = authReq.user!
    const validatedReq = req as ValidatedRequest<any, any, CreateSlashRequestBody>

    try {
      const request = createSlashRequest(validatedReq.validated.body)

      await auditLogService.logAction({
        tenantId: actor.tenantId,
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
        tenantId: actor.tenantId,
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
  }
)

router.post(
  '/slash-requests/:id/votes',
  requireUserAuth,
  validate({ params: slashRequestIdParamsSchema, body: submitVoteBodySchema }),
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest
    const actor = authReq.user!
    const validatedReq = req as ValidatedRequest<SlashRequestIdParams, any, SubmitVoteBody>
    const requestId = validatedReq.validated.params.id
    const { voterId, choice } = validatedReq.validated.body

    try {
      const result = submitVote(requestId, voterId, choice)

      if (!result) {
        res.status(404).json({ error: 'NotFound', message: 'Slash request not found' })
        return
      }

      await auditLogService.logAction({
        tenantId: actor.tenantId,
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
      const isDuplicateVoteError = message.includes('already voted')
      const statusCode = isDuplicateVoteError ? 409 : 400

      await auditLogService.logAction({
        tenantId: actor.tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: AuditAction.SLASH_VOTE_CAST,
        resourceType: 'slash_request',
        resourceId: requestId,
        details: { voterId, choice },
        status: 'failure',
        errorMessage: message,
      })

      const errorType = isDuplicateVoteError ? 'Conflict' : 'BadRequest'
      res.status(statusCode).json({ error: errorType, message })
    }
  }
)

router.get(
  '/slash-requests/:id',
  requireUserAuth,
  validate({ params: slashRequestIdParamsSchema }),
  (req: Request, res: Response) => {
    const validatedReq = req as ValidatedRequest<SlashRequestIdParams>
    const request = getSlashRequest(validatedReq.validated.params.id)
    if (!request) {
      res.status(404).json({ error: 'NotFound', message: 'Slash request not found' })
      return
    }
    res.status(200).json(request)
  }
)

router.get('/slash-requests', requireUserAuth, (req: Request, res: Response, next) => {
  try {
    const status = req.query.status as 'pending' | 'approved' | 'rejected' | undefined
    const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>)
    const { requests, total } = listSlashRequests(status, limit, offset)
    const paginationMeta = buildPaginationMeta(total, page, limit)
    res.status(200).json({ success: true, data: requests, ...paginationMeta })
  } catch (error) {
    next(error)
  }
})

export default router
