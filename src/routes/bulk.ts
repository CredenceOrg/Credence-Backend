import { Router, Request, Response } from 'express'
import { requireApiKey, ApiScope } from '../middleware/auth.js'
import { IdentityService } from '../services/identityService.js'
import { AppError, ErrorCode, ValidationError } from '../lib/errors.js'

const router = Router()
const identityService = new IdentityService()

/**
 * Configuration for bulk verification limits
 */
const BULK_LIMITS = {
  MAX_BATCH_SIZE: 100,
  MIN_BATCH_SIZE: 1,
}

/**
 * Request body schema for bulk verification
 */
interface BulkVerifyRequest {
  addresses: string[]
}

/**
 * POST /api/bulk/verify
 */
router.post(
  '/verify',
  requireApiKey(ApiScope.ENTERPRISE),
  async (req: Request, res: Response, next): Promise<void> => {
    try {
      const { addresses } = req.body as BulkVerifyRequest

      // Validate request body
      if (!addresses || !Array.isArray(addresses)) {
        throw new ValidationError('addresses must be an array')
      }

      // Validate batch size limits
      if (addresses.length < BULK_LIMITS.MIN_BATCH_SIZE) {
        throw new AppError(
          `Minimum batch size is ${BULK_LIMITS.MIN_BATCH_SIZE} address`,
          ErrorCode.BATCH_SIZE_TOO_SMALL,
          400,
          { limit: BULK_LIMITS.MIN_BATCH_SIZE, received: addresses.length }
        )
      }

      if (addresses.length > BULK_LIMITS.MAX_BATCH_SIZE) {
        throw new AppError(
          `Maximum batch size is ${BULK_LIMITS.MAX_BATCH_SIZE} addresses`,
          ErrorCode.BATCH_SIZE_EXCEEDED,
          413,
          { limit: BULK_LIMITS.MAX_BATCH_SIZE, received: addresses.length }
        )
      }

      // Validate all addresses are strings
      if (!addresses.every((addr) => typeof addr === 'string')) {
        throw new ValidationError('All addresses must be strings')
      }

      // Remove duplicates
      const uniqueAddresses = [...new Set(addresses)]

      // Perform bulk verification
      const { results, errors } = await identityService.verifyBulk(uniqueAddresses)

      // Return results with metadata
      res.status(200).json({
        results,
        errors,
        metadata: {
          totalRequested: addresses.length,
          successful: results.length,
          failed: errors.length,
          batchSize: uniqueAddresses.length,
        },
      })
    } catch (error) {
      next(error)
    }
  }
)

export default router
