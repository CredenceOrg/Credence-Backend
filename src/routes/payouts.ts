import { Router, Request, Response } from 'express'
import { idempotencyMiddleware } from '../middleware/idempotency.js'
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'
import { SettlementService } from '../services/settlementService.js'
import { validate } from '../middleware/validate.js'
import { createPayoutSchema } from '../schemas/payout.js'
/**
 * Issue #325: Import the inferred type from the Zod schema
 * instead of using `as any` cast. This ensures type safety
 * between the validated request body and the settlement service input.
 */
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
    async (req: Request, res: Response, next) => {
      try {
        /**
         * Issue #325: Use z.infer<typeof createPayoutSchema> (CreatePayoutInput)
         * instead of `as any`. The validate middleware guarantees the body
         * conforms to createPayoutSchema, so this cast is safe and fully typed.
         */
        const body = req.validated!.body as CreatePayoutInput
        
        const result = await settlementService.upsertSettlementStatus({
          bondId: body.bondId,
          amount: body.amount,
          transactionHash: body.transactionHash,
          /**
           * Issue #325: settledAt is already validated as ISO 8601 by the schema.
           * Invalid dates are rejected with 400 at the validation layer,
           * not propagated as invalid Date objects that cause 500 errors.
           */
          settledAt: body.settledAt ? new Date(body.settledAt) : undefined,
          status: body.status,
        })

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
