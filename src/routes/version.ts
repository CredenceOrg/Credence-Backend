import { Router, type Request, type Response } from 'express'
import { getVersionMetadata } from '../utils/version.js'

/**
 * Builds the version router.
 *
 * - GET /api/version -> git SHA, build timestamp, and Node version of the
 *   running process. Lets support/on-call confirm which build is deployed
 *   without shell access to the host. Always 200; no dependency checks.
 *
 * **CORS policy:** Open — `GET /api/version` accepts any `Origin`. See
 * `docs/CORS_POLICY.md`.
 */
export function createVersionRouter(): Router {
  const router = Router()

  router.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      service: 'credence-backend',
      ...getVersionMetadata(),
    })
  })

  return router
}
