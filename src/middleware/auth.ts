import { Request, Response, NextFunction } from 'express'
import { AuthError, AuthService, JwtClaims } from '../services/auth.js'

/**
 * Extended Express Request with JWT claims.
 */
export interface AuthenticatedRequest extends Request {
  auth?: JwtClaims
}

/**
 * Shared auth service instance. Reads config from env by default.
 */
const defaultAuthService = new AuthService()

/**
 * Middleware to validate JWT bearer access tokens.
 *
 * @param authService - Optional AuthService override for tests/custom config.
 * @returns Express middleware function.
 *
 * @example
 * ```typescript
 * app.post('/api/bulk/verify', requireJwtAuth(), handler)
 * ```
 */
export function requireJwtAuth(authService: AuthService = defaultAuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authorizationHeader = req.headers.authorization

    if (!authorizationHeader) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authorization header is required',
      })
      return
    }

    const [scheme, token] = authorizationHeader.split(' ')

    if (scheme !== 'Bearer' || !token) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authorization header must be in the format: Bearer <token>',
      })
      return
    }

    try {
      const claims = authService.verifyAccessToken(token)
      ;(req as AuthenticatedRequest).auth = claims
      next()
    } catch (error) {
      const message =
        error instanceof AuthError
          ? error.message
          : 'Invalid or expired authentication token'
      res.status(401).json({
        error: 'Unauthorized',
        message,
      })
    }
  }
}
