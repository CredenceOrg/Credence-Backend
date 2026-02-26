/**
 * API key middleware.
 *
 * Provides two middleware functions:
 *
 * 1. `apiKeyMiddleware` – Optional. Reads `X-API-Key` and resolves a rate
 *    tier ('standard' | 'premium') stored on `res.locals.rateTier`. Public
 *    endpoints use this so unauthenticated requests still pass through.
 *
 * 2. `requireApiKey` – Enforcing. Validates `Authorization: Bearer <key>` or
 *    `X-API-Key: <key>`, attaches the validated key record to `req.apiKey`,
 *    and returns 401/403 if the key is missing, revoked, or lacks scope.
 */

import type { Request, Response, NextFunction } from 'express'
import { validateApiKey, type KeyScope, type StoredApiKey } from '../services/apiKeys.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type RateTier = 'standard' | 'premium'

// Augment Express Request to carry the validated key record (set by requireApiKey)
declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: StoredApiKey
  }
}

// ── Optional rate-tier middleware ─────────────────────────────────────────────

/**
 * Map of valid API keys to their rate tier.
 * In production, load from a secrets store or DB.
 */
const VALID_KEYS = new Map<string, RateTier>([
  [process.env.PREMIUM_API_KEY ?? 'test-premium-key', 'premium'],
])

export function resolveRateTier(apiKey: string | undefined): RateTier {
  if (apiKey && VALID_KEYS.has(apiKey)) {
    return VALID_KEYS.get(apiKey) as RateTier
  }
  return 'standard'
}

export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string | undefined
  res.locals['rateTier'] = resolveRateTier(apiKey)
  next()
}

// ── Enforcing key middleware ──────────────────────────────────────────────────

function extractRawKey(req: Request): string | null {
  const auth = req.headers['authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  const header = req.headers['x-api-key']
  if (typeof header === 'string') return header

  return null
}

/**
 * Express middleware that validates an API key from the request.
 *
 * Accepts keys via:
 * - `Authorization: Bearer <key>`
 * - `X-API-Key: <key>`
 *
 * @param requiredScope  Optional scope requirement. Pass `'full'` to restrict
 *                       access to keys with full-access scope.
 *
 * @example
 * // Require any valid key
 * router.get('/data', requireApiKey(), handler)
 *
 * // Require full-access key
 * router.post('/write', requireApiKey('full'), handler)
 */
export function requireApiKey(requiredScope?: KeyScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawKey = extractRawKey(req)

    if (!rawKey) {
      res.status(401).json({ error: 'API key required' })
      return
    }

    const apiKey = validateApiKey(rawKey)

    if (!apiKey) {
      res.status(401).json({ error: 'Invalid or revoked API key' })
      return
    }

    if (requiredScope === 'full' && apiKey.scope !== 'full') {
      res.status(403).json({ error: 'Insufficient scope: full access required' })
      return
    }

    req.apiKey = apiKey
    next()
  }
}
