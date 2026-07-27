import { Router, type Request, type Response } from 'express'
import type { BondService, BondRecord } from '../services/bond/index.js'
import { deriveBondPaymentStatus } from '../services/bond/index.js'
import { validate, type ValidatedRequest } from '../middleware/validate.js'
import { bondPathParamsSchema, type BondPathParams } from '../schemas/index.js'
import { NotFoundError } from '../lib/errors.js'
import type { CacheService } from '../cache/redis.js'

const BOND_CACHE_TTL = 300 // 5 minutes

/**
 * Builds the bond status router.
 *
 * - GET /:address → 200 with bond data, 404 if no record
 * Validation via centralised validate() middleware rejects invalid addresses
 * with a uniform 400 error before the handler runs.
 *
 * When a CacheService instance is supplied, reads are served from cache
 * (L1 in-memory LRU → L2 Redis) with a 5-minute TTL.  The response
 * includes an `x-cache` header (HIT | MISS) for transparency.
 *
 * @param bondService  - BondService instance for querying bond status.
 * @param cacheService - Optional CacheService for read-through caching.
 * @returns Express Router
 */
export function createBondRouter(
  bondService: BondService,
  cacheService?: CacheService,
): Router {
  const router = Router()

  /**
   * GET /api/bond/:address
   *
   * Returns the bond status for an Ethereum or Stellar address.
   * Address format validation is handled by validate() middleware.
   */
  router.get(
    '/:address',
    validate({ params: bondPathParamsSchema }),
    async (req: Request, res: Response) => {
      const validatedReq = req as ValidatedRequest<BondPathParams>
      const { address } = validatedReq.validated.params

      // ── Read-through cache ────────────────────────────────────────────
      if (cacheService) {
        const cacheNs = 'bond'
        const cacheKey = address.toLowerCase()
        const cached = await cacheService.get<BondRecord>(cacheNs, cacheKey)

        if (cached) {
          res.set('x-cache', 'HIT')
          res.status(200).json({
            address: cached.address,
            bondedAmount: cached.bondedAmount,
            bondStart: cached.bondStart,
            bondDuration: cached.bondDuration,
            active: cached.active,
            slashedAmount: cached.slashedAmount,
            status: deriveBondPaymentStatus(cached),
          })
          return
        }

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

        // Fire-and-forget cache set — a failure here should not bubble up.
        cacheService.set(cacheNs, cacheKey, bond, BOND_CACHE_TTL).catch(() => {})

        res.set('x-cache', 'MISS')
        res.status(200).json({
          address: bond.address,
          bondedAmount: bond.bondedAmount,
          bondStart: bond.bondStart,
          bondDuration: bond.bondDuration,
          active: bond.active,
          slashedAmount: bond.slashedAmount,
          status: deriveBondPaymentStatus(bond),
        })
        return
      }

      // ── Uncached path (no CacheService configured) ────────────────────
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
    sendError(res, ErrorCode.SERVICE_UNAVAILABLE, 'Not implemented', undefined, 501)
  })

  return router
}
