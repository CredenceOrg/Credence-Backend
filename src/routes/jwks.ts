import { Router, type Request, type Response } from 'express'
import { createHash } from 'crypto'
import { keyManager } from '../services/keyManager/index.js'
import { sendError, ErrorCode } from '../lib/errors.js'
import { recordJwksRequest } from '../middleware/metrics.js'

export interface JwksRouterOptions {
  /**
   * Max-age (seconds) for the Cache-Control header on the JWKS endpoint.
   * Defaults to 300 (5 minutes).
   */
  cacheMaxAgeSeconds?: number
}

/**
 * Recursively sort object keys so `JSON.stringify` produces a canonical
 * representation.  `exportJWK` from `jose` does not guarantee a stable
 * property order across runs/versions, and key insertion history affects
 * `[...this.keys.values()]` — without this, two semantically identical
 * JWK Sets can hash to different ETags, defeating `304 Not Modified`.
 */
function stableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableStringify)
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, stableStringify(v)] as const)
    return Object.fromEntries(entries)
  }
  return value
}

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
 * **CORS policy:** Open — `GET /.well-known/jwks.json` accepts any `Origin`.
 * See `docs/CORS_POLICY.md`.
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
 * The response includes:
 *  - `Cache-Control: public, max-age=<cacheMaxAgeSeconds>, stale-while-revalidate=60`
 *  - `ETag: "<sha256-hex>"` derived from the canonical JWK Set body
 *
 * Clients may send `If-None-Match: <etag>` to receive `304 Not Modified`
 * instead of the full body.  This avoids re-serving the entire JWKS whenever
 * a rotated key has the same representation, which dramatically reduces
 * bandwidth while keeping a deterministic cache-busting on rotation.
 *
 * The endpoint counter `jwks_requests_total{cache="hit"|"miss",status}` lets
 * operators see cache-hit ratio and overall traffic.
 */
export function createJwksRouter(options?: JwksRouterOptions): Router {
  const cacheMaxAge = options?.cacheMaxAgeSeconds ?? 300
  const router = Router()

  router.get('/', async (req: Request, res: Response) => {
    try {
      const jwks = await keyManager.getPublicJwks()
      const body = JSON.stringify(stableStringify(jwks))
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`

      // Conditional GET — honour RFC 7232 If-None-Match.
      const ifNoneMatch = req.header('If-None-Match')
      if (ifNoneMatch && ifNoneMatch === etag) {
        recordJwksRequest('hit', 304)
        res
          .status(304)
          .set('Cache-Control', `public, max-age=${cacheMaxAge}, stale-while-revalidate=60`)
          .set('ETag', etag)
          .end()
        return
      }

      recordJwksRequest('miss', 200)
      res
        .status(200)
        .set('Cache-Control', `public, max-age=${cacheMaxAge}, stale-while-revalidate=60`)
        .set('ETag', etag)
        .type('application/json')
        .send(body)
    } catch {
      // Do not bucket errors into the JWKS cache-miss counter — that is a
      // service-availability signal, not a cache outcome.
      sendError(res, ErrorCode.SERVICE_UNAVAILABLE, 'Key manager not initialized')
    }
  })

  return router
}
