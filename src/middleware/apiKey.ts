import type { Request, Response, NextFunction } from 'express'
import { validateApiKey, type KeyScope, type StoredApiKey } from '../services/apiKeys.js'

// Augment Express Request to carry the validated key record
declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: StoredApiKey
  }
}

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
