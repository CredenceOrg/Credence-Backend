import type { Request, Response, NextFunction } from 'express'
import { ROLE_HIERARCHY } from '../types/rbac.ts'
import type { Role, AuthenticatedUser } from '../types/rbac.ts'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Structured access-denial logger. Replace with your logger (pino, winston…). */
function logDenial(
     req: Request,
     user: AuthenticatedUser | undefined,
     reason: string,
): void {
     const entry = {
          event: 'access_denied',
          method: req.method,
          path: req.path,
          reason,
          userId: user?.id ?? null,
          userRole: user?.role ?? null,
          userAddress: user?.address ?? null,
          timestamp: new Date().toISOString(),
     }
     console.warn(JSON.stringify(entry))
}

/**
 * Resolves the caller from `req.user`.
 * Returns `null` and writes a 401 response when the caller is unauthenticated.
 */
function resolveUser(
     req: Request,
     res: Response,
): AuthenticatedUser | null {
     const user = (req as any).user as AuthenticatedUser | undefined
     if (!user) {
          logDenial(req, undefined, 'unauthenticated')
          res.status(401).json({ error: 'Unauthenticated' })
          return null
     }
     return user
}

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

/**
 * Requires the caller to have **exactly** one of the listed roles.
 *
 * @example
 * router.post('/admin/slash', requireRole('admin'), handler)
 * router.get('/verify',       requireRole('admin', 'verifier'), handler)
 */
export function requireRole(...roles: Role[]) {
     return (req: Request, res: Response, next: NextFunction): void => {
          const user = resolveUser(req, res)
          if (!user) return

          if (!roles.includes(user.role)) {
               logDenial(req, user, `role "${user.role}" not in [${roles.join(', ')}]`)
               res.status(403).json({
                    error: 'Forbidden',
                    required: roles,
                    actual: user.role,
               })
               return
          }

          next()
     }
}

/**
 * Requires the caller's role to be **at least as privileged** as `minRole`
 * according to ROLE_HIERARCHY.
 *
 * @example
 * router.get('/bonds', requireMinRole('verifier'), handler)
 * // allows verifier AND admin; blocks user and public
 */
export function requireMinRole(minRole: Role) {
     return (req: Request, res: Response, next: NextFunction): void => {
          const user = resolveUser(req, res)
          if (!user) return

          if (ROLE_HIERARCHY[user.role] < ROLE_HIERARCHY[minRole]) {
               logDenial(req, user, `role "${user.role}" below minimum "${minRole}"`)
               res.status(403).json({
                    error: 'Forbidden',
                    requiredMinRole: minRole,
                    actual: user.role,
               })
               return
          }

          next()
     }
}

/**
 * Allows any authenticated caller regardless of role.
 * Blocks only unauthenticated (no `req.user`) requests.
 *
 * @example
 * router.get('/profile', requireAnyRole(), handler)
 */
export function requireAnyRole() {
     return (req: Request, res: Response, next: NextFunction): void => {
          const user = resolveUser(req, res)
          if (!user) return
          next()
     }
}