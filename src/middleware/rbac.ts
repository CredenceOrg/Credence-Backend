import type { Request, Response, NextFunction } from 'express'
import { ROLE_HIERARCHY } from '../types/rbac.ts'
import type { Role, AuthenticatedUser } from '../types/rbac.ts'
import { logger } from '../utils/logger.js'
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js'
import { rbacEngine } from '../services/rbac.service.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Structured access-denial logger. */
function logDenial(
     req: Request,
     user: AuthenticatedUser | undefined,
     reason: string,
     decision?: any,
): void {
     const entry = {
          event: 'access_denied',
          method: req.method,
          path: req.path,
          reason,
          userId: user?.id ?? null,
          userRole: user?.role ?? null,
          userAddress: user?.address ?? null,
          decision: decision ?? null,
          timestamp: new Date().toISOString(),
     }
     logger.warn(entry)
}

/** Structured access-allow logger. */
function logAllow(
     req: Request,
     user: AuthenticatedUser | undefined,
     reason: string,
     decision?: any,
): void {
     const entry = {
          event: 'access_allowed',
          method: req.method,
          path: req.path,
          reason,
          userId: user?.id ?? null,
          userRole: user?.role ?? null,
          userAddress: user?.address ?? null,
          decision: decision ?? null,
          timestamp: new Date().toISOString(),
     }
     logger.info(entry)
}

/**
 * Resolves the caller from `req.user`.
 * Throws UnauthorizedError when the caller is unauthenticated.
 */
function resolveUser(
     req: Request,
): AuthenticatedUser {
     const user = (req as any).user as AuthenticatedUser | undefined
     if (!user) {
          logDenial(req, undefined, 'unauthenticated')
          throw new UnauthorizedError('Unauthenticated')
     }
     return user
}

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

/**
 * Requires the caller to have **exactly** one of the listed roles.
 */
export function requireRole(...roles: Role[]) {
     return (req: Request, res: Response, next: NextFunction): void => {
          const user = resolveUser(req)

          if (!roles.includes(user.role)) {
               logDenial(req, user, `role "${user.role}" not in [${roles.join(', ')}]`)
               throw new ForbiddenError(`Forbidden: role "${user.role}" not in [${roles.join(', ')}]`)
          }

          next()
     }
}

/**
 * Requires the caller's role to be **at least as privileged** as `minRole`
 * according to ROLE_HIERARCHY.
 */
export function requireMinRole(minRole: Role) {
     return (req: Request, res: Response, next: NextFunction): void => {
          const user = resolveUser(req)

          if (ROLE_HIERARCHY[user.role] < ROLE_HIERARCHY[minRole]) {
               logDenial(req, user, `role "${user.role}" below minimum "${minRole}"`)
               throw new ForbiddenError(`Forbidden: role "${user.role}" below minimum "${minRole}"`)
          }

          next()
     }
}

/**
 * Allows any authenticated caller regardless of role.
 */
export function requireAnyRole() {
     return (req: Request, res: Response, next: NextFunction): void => {
          resolveUser(req)
          next()
     }
}

/**
 * Requires the caller to have permission to perform an action on a resource.
 * Uses the RBAC policy engine with auditable decisions.
 */
export function requirePermission(action: string, resource: string) {
     return (req: Request, res: Response, next: NextFunction): void => {
          // If no user, default to public
          const user = (req as any).user as AuthenticatedUser | undefined
          const roles = user ? [user.role] : ['public']

          const decision = rbacEngine.evaluate(roles, action, resource, {
               path: req.path,
               method: req.method,
               ip: req.ip,
               userId: user?.id
          });

          // Attach decision to request for downstream audit trails if needed
          (req as any).rbacDecision = decision;

          if (!decision.allowed) {
               logDenial(req, user, decision.reason, decision)
               throw new ForbiddenError(`Forbidden: ${decision.reason}`)
          }

          logAllow(req, user, decision.reason, decision)
          next()
     }
}