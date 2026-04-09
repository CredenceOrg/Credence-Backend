import { Router, type Request, type Response } from 'express'
import { getTrustScore } from '../services/reputationService.js'
import { apiKeyMiddleware } from '../middleware/apiKey.js'
import { validate } from '../middleware/validate.js'
import { trustPathParamsSchema } from '../schemas/index.js'
import { NotFoundError } from '../lib/errors.js'

const router = Router()

router.get(
  '/:address',
  validate({ params: trustPathParamsSchema }),
  apiKeyMiddleware,
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
