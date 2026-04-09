import { Router, type Request, type Response } from 'express'
import { keyManager } from '../services/keyManager/index.js'

/**
 * Creates the router for the JWK Set (JWKS) endpoint.
 *
 * ## Endpoint
 * `GET /.well-known/jwks.json`
 *
 * Returns the set of active and grace-period public keys used to verify JWTs
 * issued by this service. No authentication is required — the endpoint is
 * intentionally public per RFC 8414 / OIDC Discovery conventions.
 *
 * ## Key lifecycle
 * - **Active key**: the current signing key.
 * - **Retired key**: a recently rotated key kept alive for `KEY_GRACE_PERIOD_SECONDS`
 *   (default 3600 s) so tokens signed before the rotation remain verifiable.
 *   After the grace period plus `KEY_CLOCK_SKEW_SECONDS` (default 300 s), the key
 *   is hard-pruned and removed from this endpoint.
 *
 * ## Clock skew
 * Verifiers consuming this endpoint should apply a `clockTolerance` of at least
 * `KEY_CLOCK_SKEW_SECONDS` (default 300 s) when calling `jwtVerify()`, to tolerate
 * tokens whose `exp` or `iat` values differ slightly due to clock drift.
 *
 * ## Caching
 * The response includes `Cache-Control: public, max-age=300, stale-while-revalidate=60`.
 * Consumers caching this response should re-fetch when they encounter an unknown
 * `kid` in a JWT header, as a rotation may have occurred.
 */
export function createJwksRouter(): Router {
  const router = Router()

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const jwks = await keyManager.getPublicJwks()
      res
        .status(200)
        .set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60')
        .json(jwks)
    } catch {
      res.status(503).json({ error: 'Key manager not initialized' })
    }
  })

  return router
}
