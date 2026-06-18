import { Router, type Request, type Response } from 'express'
import { SettlementsRepository } from '../db/repositories/settlementsRepository.js'
import { encodeCursor } from '../lib/pagination.js'
import { pool } from '../db/pool.js'
import { validate, type ValidatedRequest } from '../middleware/validate.js'
import { transactionsHistoryQuerySchema, type TransactionsHistoryQuery } from '../schemas/transactions.js'

/**
 * Creates the transactions router for history and reporting.
 */
export function createTransactionsRouter(): Router {
  const router = Router()
  const settlementsRepo = new SettlementsRepository(pool)

  /**
   * GET /api/transactions/history
   *
   * Fetches transaction history (settlements) with stable cursor-based pagination.
   * Query params validated by Zod before handler runs.
   *
   * @query {number} [limit=20]     - Page size (1–100)
   * @query {string} [cursor]       - Opaque pagination cursor from previous response
   * @query {string} [bondId]       - Filter settlements by bond ID
   */
  router.get(
    '/history',
    validate({ query: transactionsHistoryQuerySchema }),
    async (req: Request, res: Response, next) => {
      try {
        const validatedReq = req as ValidatedRequest<any, TransactionsHistoryQuery>
        const { limit = 20, cursor, bondId } = validatedReq.validated.query

        const settlements = await settlementsRepo.findManyPaginated({
          limit,
          cursor,
          bondId,
        })

        let nextCursor: string | null = null
        if (settlements.length > 0) {
          const last = settlements[settlements.length - 1]
          nextCursor = encodeCursor(last.settledAt.toISOString(), last.id)
        }

        res.status(200).json({
          success: true,
          data: settlements,
          next_cursor: nextCursor,
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

export default createTransactionsRouter
