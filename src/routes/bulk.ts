import { Router, Request, Response } from 'express'
import { requireApiKey, ApiScope } from '../middleware/auth.js'
import { IdentityService } from '../services/identityService.js'

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
 * 
 * Bulk identity verification endpoint for enterprise tier
 * Accepts a list of addresses and returns trust score and bond status for each
 * 
 * @requires Enterprise API key via X-API-Key header
 * 
 * @body {string[]} addresses - Array of Stellar addresses to verify (1-100)
 * 
 * @returns {object} Response containing:
 *   - results: Array of successful verifications
 *   - errors: Array of failed verifications with error details
 *   - metadata: Batch processing statistics
 * 
 * @example
 * ```bash
 * curl -X POST http://localhost:3000/api/bulk/verify \
 *   -H "Content-Type: application/json" \
 *   -H "X-API-Key: test-enterprise-key-12345" \
 *   -d '{"addresses": ["GABC...", "GDEF..."]}'
 * ```
 * 
 * @example Response (200 OK)
 * ```json
 * {
 *   "results": [
 *     {
 *       "address": "GABC...",
 *       "trustScore": 85,
 *       "bondStatus": {
 *         "bondedAmount": "5000.00",
 *         "bondStart": "2024-01-15T10:30:00.000Z",
 *         "bondDuration": 365,
 *         "active": true
 *       },
 *       "attestationCount": 12,
 *       "lastUpdated": "2024-02-24T10:30:00.000Z"
 *     }
 *   ],
 *   "errors": [
 *     {
 *       "address": "INVALID",
 *       "error": "VerificationFailed",
 *       "message": "Invalid Stellar address format"
 *     }
 *   ],
 *   "metadata": {
 *     "totalRequested": 2,
 *     "successful": 1,
 *     "failed": 1,
 *     "batchSize": 2
 *   }
 * }
 * ```
 * 
 * @example Error Response (400 Bad Request)
 * ```json
 * {
 *   "error": "InvalidRequest",
 *   "message": "addresses must be an array"
 * }
 * ```
 * 
 * @example Error Response (401 Unauthorized)
 * ```json
 * {
 *   "error": "Unauthorized",
 *   "message": "API key is required"
 * }
 * ```
 * 
 * @example Error Response (403 Forbidden)
 * ```json
 * {
 *   "error": "Forbidden",
 *   "message": "Enterprise API key required"
 * }
 * ```
 * 
 * @example Error Response (413 Payload Too Large)
 * ```json
 * {
 *   "error": "BatchSizeExceeded",
 *   "message": "Maximum batch size is 100 addresses",
 *   "limit": 100,
 *   "received": 150
 * }
 * ```
 */
router.post(
  '/verify',
  requireApiKey(ApiScope.ENTERPRISE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { addresses } = req.body as BulkVerifyRequest

      // Validate request body
      if (!addresses || !Array.isArray(addresses)) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'addresses must be an array',
        })
        return
      }

      // Validate batch size limits
      if (addresses.length < BULK_LIMITS.MIN_BATCH_SIZE) {
        res.status(400).json({
          error: 'BatchSizeTooSmall',
          message: `Minimum batch size is ${BULK_LIMITS.MIN_BATCH_SIZE} address`,
          limit: BULK_LIMITS.MIN_BATCH_SIZE,
          received: addresses.length,
        })
        return
      }

      if (addresses.length > BULK_LIMITS.MAX_BATCH_SIZE) {
        res.status(413).json({
          error: 'BatchSizeExceeded',
          message: `Maximum batch size is ${BULK_LIMITS.MAX_BATCH_SIZE} addresses`,
          limit: BULK_LIMITS.MAX_BATCH_SIZE,
          received: addresses.length,
        })
        return
      }

      // Validate all addresses are strings
      if (!addresses.every((addr) => typeof addr === 'string')) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'All addresses must be strings',
        })
        return
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
      // Handle unexpected errors
      console.error('Bulk verification error:', error)
      res.status(500).json({
        error: 'InternalServerError',
        message: 'An unexpected error occurred during bulk verification',
      })
    }
  }
)

export default router
