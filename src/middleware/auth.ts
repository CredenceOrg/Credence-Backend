import { Request, Response, NextFunction } from 'express'

/**
 * API key scopes for authorization
 */
export enum ApiScope {
  PUBLIC = 'public',
  ENTERPRISE = 'enterprise',
}

/**
 * User roles for role-based access control
 */
export enum UserRole {
  ADMIN = 'admin',
  VERIFIER = 'verifier',
  USER = 'user',
}

/**
 * Extended Express Request with API key and user metadata
 */
export interface AuthenticatedRequest extends Request {
  apiKey?: {
    key: string
    scope: ApiScope
  }
  user?: {
    id: string
    role: UserRole
    email: string
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
 * Mock user store - in production, use database or identity provider
 * Format: { userId: { id, role, email, apiKey } }
 */
export const MOCK_USERS: Record<string, { id: string; role: UserRole; email: string; apiKey: string }> = {
  'admin-user-1': {
    id: 'admin-user-1',
    role: UserRole.ADMIN,
    email: 'admin@credence.org',
    apiKey: 'admin-key-12345',
  },
  'verifier-user-1': {
    id: 'verifier-user-1',
    role: UserRole.VERIFIER,
    email: 'verifier@credence.org',
    apiKey: 'verifier-key-67890',
  },
}

/**
 * Mock API key to user mapping - in production, use database
 */
export const API_KEY_TO_USER: Record<string, string> = {
  'admin-key-12345': 'admin-user-1',
  'verifier-key-67890': 'verifier-user-1',
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

/**
 * Middleware to check if user has admin role
 * Should be used after user authentication is established
 * 
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * app.post('/api/admin/users', requireAdminRole, handler)
 * ```
 */
export function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest

  if (!authReq.user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'User authentication required',
    })
    return
  }

  if (authReq.user.role !== UserRole.ADMIN) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin role required',
    })
    return
  }

  next()
}

/**
 * Middleware to authenticate user from Authorization header (Bearer token format)
 * Should be used before requireAdminRole
 * 
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * app.use('/api/admin', requireUserAuth, requireAdminRole, adminRouter)
 * ```
 */
export function requireUserAuth(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer token required',
    })
    return
  }

  const apiKey = authHeader.substring(7) // Remove 'Bearer ' prefix
  const userId = API_KEY_TO_USER[apiKey]

  if (!userId) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    })
    return
  }

  const user = MOCK_USERS[userId]
  if (!user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'User not found',
    })
    return
  }

  authReq.user = {
    id: user.id,
    role: user.role,
    email: user.email,
  }

  next()
}
