import { Router, Response } from 'express'
import { idempotencyMiddleware } from '../middleware/idempotency.js'
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'
import { SettlementService } from '../services/settlementService.js'
import { validate, ValidatedRequest } from '../middleware/validate.js'
import { createPayoutSchema } from '../schemas/payout.js'
import type { CreatePayoutInput } from '../schemas/payout.js'
import { pool } from '../db/pool.js'
import { SettlementsRepository } from '../db/repositories/settlementsRepository.js'
import { requireApiKey, ApiScope } from '../middleware/auth.js'

/**
 * Creates the payouts router with idempotency protection.
 */
export function createPayoutsRouter(): Router {
  const router = Router()
  
  const idempotencyRepo = new IdempotencyRepository(pool)
  const settlementsRepo = new SettlementsRepository(pool)
  const settlementService = new SettlementService(settlementsRepo)

  /**
   * POST /api/payouts
   * 
   * Creates a new payout record.
   * Protected by idempotency keys to prevent duplicate payouts on retries.
   *
   * @requires payouts:write scope
   */
  router.post(
    '/',
    requireApiKey(ApiScope.PAYOUTS_WRITE),
    idempotencyMiddleware(idempotencyRepo),
    validate({ body: createPayoutSchema }),
    async (req: ValidatedRequest<any, any, CreatePayoutInput>, res: Response, next) => {
      try {
        const result = await settlementService.upsertSettlementStatus(req.validated.body)

        res.status(201).json({
          success: true,
          data: result,
        })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}

export default createPayoutsRouter
