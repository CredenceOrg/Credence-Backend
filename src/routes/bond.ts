import { Router, type Request, type Response } from 'express'
import type { BondService } from '../services/bond/index.js'

/**
 * Builds the bond status router.
 *
 * - GET /:address → 200 with bond data, 400 if address invalid, 404 if no record
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
   * Validates address format and returns appropriate error responses.
   */
  router.get('/:address', (req: Request, res: Response) => {
    const { address } = req.params

    if (!bondService.isValidAddress(address)) {
      res.status(400).json({
        error:
          'Invalid address format. Expected an Ethereum address: 0x followed by 40 hex characters.',
      })
      return
    }

    const bond = bondService.getBondStatus(address)

    if (!bond) {
      res.status(404).json({
        error: `No bond record found for address ${address.toLowerCase()}.`,
      })
      return
    }

    res.status(200).json({
      address: bond.address,
      bondedAmount: bond.bondedAmount,
      bondStart: bond.bondStart,
      bondDuration: bond.bondDuration,
      active: bond.active,
      slashedAmount: bond.slashedAmount,
    })
  })

  return router
}
