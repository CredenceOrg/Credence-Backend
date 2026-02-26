/**
 * GET /api/trust/:address
 *
 * Returns the trust score for a given Ethereum address.
 *
 * Path params:
 *   address  – Ethereum address (0x-prefixed, 40 hex chars, case-insensitive)
 *
 * Request headers (all optional):
 *   X-API-Key  – API key; unlocks the 'premium' rate tier
 *
 * Responses:
 *   200  { address, score, bondedAmount, bondStart, attestationCount, agreedFields? }
 *   400  { error }  – address format invalid
 *   404  { error }  – no identity record for this address
 *
 * @example
 * GET /api/trust/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
 * →
 * {
 *   "address": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
 *   "score": 100,
 *   "bondedAmount": "1000000000000000000",
 *   "bondStart": "2024-01-15T00:00:00.000Z",
 *   "attestationCount": 5,
 *   "agreedFields": { "name": "Alice", "role": "validator" }
 * }
 */

import { Router, type Request, type Response } from 'express'
import { getTrustScore } from '../services/reputationService.js'
import { apiKeyMiddleware } from '../middleware/apiKey.js'
import { validate } from '../middleware/validate.js'
import { trustPathParamsSchema } from '../schemas/index.js'

const router = Router()

router.get(
  '/:address',
  validate({ params: trustPathParamsSchema }),
  apiKeyMiddleware,
  (req: Request, res: Response) => {
    const { address } = req.validated!.params! as { address: string }

    const trustScore = getTrustScore(address)

    if (!trustScore) {
      res.status(404).json({
        error: `No identity record found for address ${address}.`,
      })
      return
    }

    res.json(trustScore)
  },
)

export default router
