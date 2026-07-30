import { Router, type Request, type Response } from 'express'
import {
  createAuthRateLimitMiddleware,
  type AuthRateLimitConfig,
} from '../middleware/authRateLimit.js'
import { validate } from '../middleware/validate.js'
import { authLoginBodySchema, authRefreshBodySchema } from '../schemas/auth.js'

/**
 * Auth routes (login / refresh) with dedicated per-tenant rate limiting.
 * Credential verification is handled by upstream identity integration; these
 * handlers respond with auth failure until that wiring is complete.
 */
export function createAuthRouter(config: AuthRateLimitConfig): Router {
  const router = Router()
  const authRateLimit = createAuthRateLimitMiddleware(config)

  router.post(
    '/login',
    authRateLimit,
    validate({ body: authLoginBodySchema }),
    (_req: Request, res: Response) => {
      res.status(401).json({ error: 'Invalid credentials', code: 'auth_failed' })
    },
  )

  router.post(
    '/refresh',
    authRateLimit,
    validate({ body: authRefreshBodySchema }),
    (_req: Request, res: Response) => {
      res.status(401).json({ error: 'Invalid refresh token', code: 'auth_failed' })
    },
  )

  return router
}
