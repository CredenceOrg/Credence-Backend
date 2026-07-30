/**
 * Express middleware factory for fine-grained policy enforcement.
 *
 * Usage:
 *   router.get('/orgs/:orgId/members',
 *     requireUserAuth,
 *     requirePolicy('org:member:list', (req) => `org:${req.params.orgId}:members`),
 *     handler,
 *   )
 *
 * The middleware:
 *  1. Resolves the caller from req.user (set by requireUserAuth).
 *  2. Resolves orgId from req.params.orgId (or the resourceFn return value).
 *  3. Calls policyService.authorize() with the full context.
 *  4. Passes on 200 or responds 403 with the denial reason.
 */

import type { Request, Response, NextFunction } from 'express'
import { policyService } from '../services/policy/service.js'
import type { PolicyAction } from '../services/policy/types.js'
import type { AuthenticatedRequest } from './auth.js'

type ResourceResolver = (req: Request) => string

/**
 * Require a specific policy action to be allowed for the caller.
 *
 * @param action       The action being attempted (e.g. 'org:member:list').
 * @param resourceFn   Optional function to derive the resource string from the
 *                     request. Defaults to `org:<req.params.orgId>`.
 */
export function requirePolicy(action: PolicyAction, resourceFn?: ResourceResolver) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest
    const user = authReq.user

    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' })
      return
    }

    const orgId = (req.params as Record<string, string>).orgId ?? 'global'
    const resource = resourceFn ? resourceFn(req) : `org:${orgId}`

    const decision = policyService.authorize({
      userId: user.id,
      role: user.role as import('../services/policy/types.js').Role,
      orgId,
      action,
      resource,
    })

    if (!decision.allowed) {
      res.status(403).json({
        error: 'Forbidden',
        reason: decision.reason,
      })
      return
    }

    next()
  }
}
