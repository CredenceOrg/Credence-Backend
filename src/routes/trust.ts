import { Router, type Request, type Response } from 'express'
import { getTrustScore } from '../services/reputationService.js'
import { requireApiKey, requireScope } from '../middleware/apiKey.js'
import { validate } from '../middleware/validate.js'
import { trustPathParamsSchema } from '../schemas/index.js'
import { NotFoundError } from '../lib/errors.js'
import { ApiKeyScope } from '../services/apiKeys.js'

const router = Router()

router.get(
  '/:address',
  validate({ params: trustPathParamsSchema }),
  requireApiKey(),
  requireScope(ApiKeyScope.TRUST_READ),
  (req: Request, res: Response) => {
    const { address } = req.validated!.params! as { address: string }

    const trustScore = getTrustScore(address)

    if (!trustScore) {
      throw new NotFoundError('Identity record', address)
    }

    res.json(trustScore)
  },
)

export default router
