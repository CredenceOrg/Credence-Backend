import { Router, type Request, type Response } from 'express'
import { requireJwtAuth } from '../middleware/auth.js'
import {
  ConsoleArbitrationEventPublisher,
  DisputeSubmissionError,
  DisputeSubmissionService,
  PgDisputeSubmissionRepository,
  type DisputeSubmissionInput,
} from '../services/governance/disputeSubmissions.js'

/**
 * Route-local request body type for dispute submissions.
 */
interface SubmitDisputeBody {
  slash_request_id: string
  identity: string
  evidence: string[]
  stake?: string
}

/**
 * Builds governance router exposing dispute submission APIs.
 */
export function createGovernanceRouter(
  service: DisputeSubmissionService = new DisputeSubmissionService(
    new PgDisputeSubmissionRepository(),
    new ConsoleArbitrationEventPublisher()
  )
): Router {
  const router = Router()

  router.post('/disputes', requireJwtAuth(), async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as SubmitDisputeBody
      const input: DisputeSubmissionInput = {
        slashRequestId: body?.slash_request_id,
        identity: body?.identity,
        evidence: body?.evidence,
        stake: body?.stake,
      }

      const dispute = await service.submit(input)
      res.status(201).json({
        dispute: {
          id: dispute.id,
          slash_request_id: dispute.slashRequestId,
          identity: dispute.identity,
          evidence: dispute.evidence,
          stake: dispute.stake,
          status: dispute.status,
          submitted_at: dispute.submittedAt.toISOString(),
        },
        arbitration: {
          event: 'governance.dispute_submitted',
          queued: true,
        },
      })
    } catch (error) {
      if (error instanceof DisputeSubmissionError) {
        if (error.code === 'VALIDATION_ERROR') {
          res.status(400).json({ error: 'ValidationError', message: error.message })
          return
        }
        if (error.code === 'SLASH_REQUEST_NOT_FOUND') {
          res.status(404).json({ error: 'NotFound', message: error.message })
          return
        }
        if (error.code === 'DEADLINE_PASSED') {
          res.status(422).json({ error: 'DeadlinePassed', message: error.message })
          return
        }
        if (error.code === 'NOT_DISPUTABLE' || error.code === 'ALREADY_DISPUTED' || error.code === 'IDENTITY_MISMATCH') {
          res.status(409).json({ error: 'Conflict', message: error.message })
          return
        }
      }

      res.status(500).json({
        error: 'InternalServerError',
        message: error instanceof Error ? error.message : 'unexpected governance error',
      })
    }
  })

  return router
}
