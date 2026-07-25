import { Router, type Request, type Response } from 'express'
import type { BondService } from '../services/bond/index.js'
import { deriveBondPaymentStatus } from '../services/bond/index.js'
import { validate, type ValidatedRequest } from '../middleware/validate.js'
import { bondPathParamsSchema, type BondPathParams } from '../schemas/index.js'
import { NotFoundError } from '../lib/errors.js'

/**
 * Builds the bond status router.
 *
 * - GET /:address → 200 with bond data, 404 if no record
 * Validation via centralised validate() middleware rejects invalid addresses
 * with a uniform 400 error before the handler runs.
 *
 * @param bondService - BondService instance for querying bond status.
 * @returns Express Router
 */
export function createBondRouter(bondService: BondService): Router {
  const router = Router()

  /**
   * GET /api/bond/:address
   *
   * Returns the bond status for an Ethereum address.
   * Address format validation is handled by validate() middleware.
   */
  router.get(
    '/:address',
    validate({ params: bondPathParamsSchema }),
    (req: Request, res: Response) => {
      const validatedReq = req as ValidatedRequest<BondPathParams>
      const { address } = validatedReq.validated.params

      const bond = bondService.getBondStatus(address)

      if (!bond) {
        const err = new NotFoundError('Bond record', address)
        res.status(err.status).json({
          error: err.message,
          code: err.code,
          error_code: err.code,
        })
        return
      }

      res.status(200).json({
        address: bond.address,
        bondedAmount: bond.bondedAmount,
        bondStart: bond.bondStart,
        bondDuration: bond.bondDuration,
        active: bond.active, // deprecated: use `status` instead
        slashedAmount: bond.slashedAmount,
        status: deriveBondPaymentStatus(bond),
      })
    },
  )

  /**
   * POST /api/bond
   *
   * Creates or tops up a bond. Stub — full implementation pending on-chain write layer.
   */
  router.post('/', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  return router
}
