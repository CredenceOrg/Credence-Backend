/**
 * API key middleware.
 *
 * Provides three middleware functions:
 *
 * 1. `apiKeyMiddleware` – Optional. Reads `X-API-Key` and resolves a rate
 *    tier ('standard' | 'premium') stored on `res.locals.rateTier`. Public
 *    endpoints use this so unauthenticated requests still pass through.
 *
 * 2. `requireApiKey` – Enforcing. Validates `Authorization: Bearer <key>` or
 *    `X-API-Key: <key>`, attaches the validated key record to `req.apiKeyRecord`,
 *    and returns 401/403 if the key is missing, revoked, or lacks scope.
 *
 * 3. `requireScope` – Enforcing. Checks if the validated API key has the
 *    required scope. Must be used after `requireApiKey`.
 */

import type { Request, Response, NextFunction } from 'express'
import { validateApiKey, type KeyScope, type StoredApiKey, ApiKeyScope } from '../services/apiKeys.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type RateTier = 'standard' | 'premium'

// ── Realms (scope-group definitions) ─────────────────────────────────────────

/**
 * A "realm" is a named set of granular scopes that a legacy scope can expand to.
 * An ENTERPRISE / 'full' key is implicitly granted every scope (no realm needed).
 */
const REALMS: Record<string, ReadonlySet<string>> = {
  public: new Set([
    ApiKeyScope.TRUST_READ,
    ApiKeyScope.ATTESTATIONS_READ,
    ApiKeyScope.BOND_READ,
  ]),
}

/** Legacy scope values that imply broader access. */
const LEGACY_FULL = new Set(['full', 'enterprise'])
const LEGACY_READ = new Set(['read', 'public'])

// Augment Express Request to carry the validated key record (set by requireApiKey)
declare module 'express-serve-static-core' {
  interface Request {
    apiKeyRecord?: StoredApiKey
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
 * Check whether a set of granted scopes satisfies the required scope.
 *
 * Rules (in order):
 * 1. Direct match → allow.
 * 2. Granted scopes contain 'full' or 'enterprise' → allow (superset of all).
 * 3. If granted scopes contain 'read' or 'public' and the required scope is in
 *    the public realm → allow.
 * 4. Otherwise → deny.
 */
export function scopeSatisfies(grantedScopes: string[], requiredScope: string): boolean {
  // Exact match
  if (grantedScopes.includes(requiredScope)) return true

  // Full/enterprise superset
  if (grantedScopes.some((s) => LEGACY_FULL.has(s))) return true

  // Public/read realm expansion
  if (grantedScopes.some((s) => LEGACY_READ.has(s))) {
    const realm = REALMS['public']
    if (realm?.has(requiredScope)) return true
  }

  return false
}

/**
 * Express middleware that validates an API key from the request.
 *
 * Accepts keys via:
 * - `Authorization: Bearer <key>`
 * - `X-API-Key: <key>`
 *
 * @example
 * // Require any valid key
 * router.get('/data', requireApiKey(), handler)
 *
 * // Require key with specific scope (use requireScope middleware instead)
 * router.post('/write', requireApiKey(), requireScope(ApiKeyScope.BOND_WRITE), handler)
 */
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js'

export function requireApiKey() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = extractRawKey(req)

    if (!rawKey) {
      throw new UnauthorizedError('API key required')
    }

    const apiKey = await validateApiKey(rawKey)

    if (!apiKey) {
      throw new UnauthorizedError('Invalid or revoked API key')
    }

    req.apiKeyRecord = apiKey
    next()
  }
}

/**
 * Express middleware that checks if the validated API key has the required scope.
 * Must be used after `requireApiKey` middleware.
 *
 * Supports:
 * - Granular scope matching (e.g. `trust:read`)
 * - Legacy 'full' / 'enterprise' → superset of all scopes
 * - Legacy 'read' / 'public' → realm-based expansion
 *
 * @param requiredScope  The scope required to access this endpoint
 *
 * @example
 * router.get('/bonds', requireApiKey(), requireScope(ApiKeyScope.BOND_READ), handler)
 * router.post('/attestations', requireApiKey(), requireScope(ApiKeyScope.ATTESTATION_WRITE), handler)
 */
export function requireScope(requiredScope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = req.apiKeyRecord

    if (!apiKey) {
      throw new UnauthorizedError('API key required')
    }

    if (!scopeSatisfies(apiKey.scopes, requiredScope)) {
      throw new ForbiddenError(
        `Insufficient scope: '${requiredScope}' is required, granted: [${apiKey.scopes.join(', ')}]`,
      )
    }

    next()
  }
}
