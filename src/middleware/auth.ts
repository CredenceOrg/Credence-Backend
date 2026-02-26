import { Request, Response, NextFunction } from 'express'

/**
 * API key scopes for authorization
 */
export enum ApiScope {
  PUBLIC = 'public',
  ENTERPRISE = 'enterprise',
}

/**
 * Extended Express Request with API key metadata
 */
export interface AuthenticatedRequest extends Request {
  apiKey?: {
    key: string
    scope: ApiScope
  }
}

/**
 * Mock API key store - in production, use database or secret manager
 * Format: { key: scope }
 */
const API_KEYS: Record<string, ApiScope> = {
  'test-enterprise-key-12345': ApiScope.ENTERPRISE,
  'test-public-key-67890': ApiScope.PUBLIC,
}

/**
 * Middleware to validate API key and check required scope
 * 
 * @param requiredScope - Minimum scope required for the endpoint
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * app.post('/api/bulk/verify', requireApiKey(ApiScope.ENTERPRISE), handler)
 * ```
 */
export function requireApiKey(requiredScope: ApiScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = req.headers['x-api-key'] as string

    if (!apiKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'API key is required',
      })
      return
    }

    const scope = API_KEYS[apiKey]

    if (!scope) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid API key',
      })
      return
    }

    // Check if the key has sufficient scope
    if (requiredScope === ApiScope.ENTERPRISE && scope !== ApiScope.ENTERPRISE) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Enterprise API key required',
      })
      return
    }

    // Attach API key metadata to request
    ;(req as AuthenticatedRequest).apiKey = { key: apiKey, scope }
    next()
  }
}
