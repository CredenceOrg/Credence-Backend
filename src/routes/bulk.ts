import { Router, Request, Response } from 'express'
import { requireApiKey, ApiScope } from '../middleware/auth.js'
import { VerificationService } from '../services/verificationService.js'
import { AppError, ErrorCode, ValidationError } from '../lib/errors.js'

const router = Router()
const verificationService = new VerificationService()

const BULK_LIMITS = {
  MAX_SYNC_BATCH_SIZE: 100,
  MAX_ASYNC_BATCH_SIZE: 10000,
  MIN_BATCH_SIZE: 1,
}

interface BulkVerifyRequest {
  addresses: string[]
}

router.post(
  '/verify',
  requireApiKey(ApiScope.ENTERPRISE),
  async (req: Request, res: Response, next): Promise<void> => {
    try {
      const { addresses } = req.body as BulkVerifyRequest

      if (!addresses || !Array.isArray(addresses)) {
        throw new ValidationError('addresses must be an array')
      }

      if (addresses.length < BULK_LIMITS.MIN_BATCH_SIZE) {
        throw new AppError(
          `Minimum batch size is ${BULK_LIMITS.MIN_BATCH_SIZE} address`,
          ErrorCode.BATCH_SIZE_TOO_SMALL,
          400,
          { limit: BULK_LIMITS.MIN_BATCH_SIZE, received: addresses.length }
        )
      }

      if (addresses.length > BULK_LIMITS.MAX_ASYNC_BATCH_SIZE) {
        throw new AppError(
          `Maximum batch size is ${BULK_LIMITS.MAX_ASYNC_BATCH_SIZE} addresses`,
          ErrorCode.BATCH_SIZE_EXCEEDED,
          413,
          { limit: BULK_LIMITS.MAX_ASYNC_BATCH_SIZE, received: addresses.length }
        )
      }

      if (!addresses.every((addr) => typeof addr === 'string')) {
        throw new ValidationError('All addresses must be strings')
      }

      const uniqueAddresses = [...new Set(addresses)]

      if (uniqueAddresses.length > BULK_LIMITS.MAX_SYNC_BATCH_SIZE) {
        // Compute server-side metadata to prevent clients from influencing
        // scheduler behavior. Use the API key identifier as `orgId` when
        // available; fall back to 'unknown'.
        const orgId = (req as any).apiKey?.key ?? 'unknown'
        const jobId = await verificationService.enqueueBulkVerification(uniqueAddresses, { orgId, size: uniqueAddresses.length })
        res.status(202).json({
          message: 'Batch verification queued',
          jobId,
          metadata: {
            totalRequested: addresses.length,
            batchSize: uniqueAddresses.length,
          }
        })
        return
      }

      const { results, errors } = await verificationService.verifyBulkChunked(uniqueAddresses)

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
