import { Router, type Request, type Response, type NextFunction } from 'express'
import { getTrustScore } from '../services/reputationService.js'
import { PgTrustIdentityRepository } from '../db/repositories/trustIdentityRepository.js'
import { pool, withReplica } from '../db/pool.js'
import { apiKeyMiddleware } from '../middleware/apiKey.js'
import { validate, type ValidatedRequest } from '../middleware/validate.js'
import { trustPathParamsSchema, type TrustPathParams } from '../schemas/index.js'
import { NotFoundError } from '../lib/errors.js'
import { createHash } from 'crypto'

const router = Router()

function generateEtag(data: any): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

router.get(
  '/:address',
  validate({ params: trustPathParamsSchema }),
  apiKeyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedReq = req as ValidatedRequest<TrustPathParams>
      const { address } = validatedReq.validated.params

      const trustScore = await withReplica(async (client) => {
        const trustRepo = new PgTrustIdentityRepository(client)
        return await getTrustScore(address, trustRepo)
      })

      if (!trustScore) {
        throw new NotFoundError('Identity record', address)
      }

      const etag = generateEtag(trustScore)
      res.set('ETag', etag)
      res.set('Cache-Control', 'public, max-age=60')

      if (req.headers['if-none-match'] === etag) {
        res.status(304).send()
        return
      }

      res.json(trustScore)
    } catch (error) {
      next(error)
    }
  }
)

export default router