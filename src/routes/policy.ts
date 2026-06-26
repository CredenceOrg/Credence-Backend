/**
 * Policy management routes.
 *
 * All mutations require admin role. Rule reads require at minimum the
 * org:policy:read permission (or admin fallback).
 *
 * POST   /api/orgs/:orgId/policies          – create rule
 * GET    /api/orgs/:orgId/policies          – list rules
 * GET    /api/orgs/:orgId/policies/:ruleId  – get rule
 * PATCH  /api/orgs/:orgId/policies/:ruleId  – update rule
 * DELETE /api/orgs/:orgId/policies/:ruleId  – delete rule
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { requireUserAuth, requireAdminRole } from '../middleware/auth.js'
import { requirePolicy } from '../middleware/policy.js'
import { validate, type ValidatedRequest } from '../middleware/validate.js'
import { policyService } from '../services/policy/service.js'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import {
  buildPaginationMeta,
  parsePaginationParams,
} from '../lib/pagination.js'
import {
  createPolicyBodySchema,
  updatePolicyBodySchema,
  policyOrgPathParamsSchema,
  policyRulePathParamsSchema,
  policyListQuerySchema,
  type CreatePolicyBody,
  type UpdatePolicyBody,
  type PolicyOrgPathParams,
  type PolicyRulePathParams,
} from '../schemas/policy.js'

export function createPolicyRouter(): Router {
  const router = Router({ mergeParams: true })

  // POST /api/orgs/:orgId/policies
  router.post(
    '/',
    requireUserAuth,
    requireAdminRole,
    validate({ params: policyOrgPathParamsSchema, body: createPolicyBodySchema }),
    (req: Request, res: Response) => {
      const validatedReq = req as ValidatedRequest<PolicyOrgPathParams, any, CreatePolicyBody>
      const authReq = req as unknown as AuthenticatedRequest
      const { orgId } = validatedReq.validated.params
      const body = validatedReq.validated.body

      try {
        const user = authReq.user!
        const rule = policyService.createRule(user.tenantId, user.id, user.email, {
          orgId,
          subject: body.subject,
          action: body.action,
          resource: body.resource,
          effect: body.effect,
          conditions: body.conditions,
        })
        res.status(201).json({ success: true, data: rule })
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
      }
    },
  )

  // GET /api/orgs/:orgId/policies
  router.get(
    '/',
    requireUserAuth,
    requirePolicy('org:policy:read', (req) => `org:${req.params.orgId}`),
    validate({ params: policyOrgPathParamsSchema, query: policyListQuerySchema }),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const validatedReq = req as ValidatedRequest<PolicyOrgPathParams>
        const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>)
        const { rules, total } = policyService.listRules(validatedReq.validated.params.orgId, limit, offset)
        const paginationMeta = buildPaginationMeta(total, page, limit)
        res.json({ success: true, data: rules, ...paginationMeta })
      } catch (error) {
        next(error)
      }
    },
  )

  // GET /api/orgs/:orgId/policies/:ruleId
  router.get(
    '/:ruleId',
    requireUserAuth,
    requirePolicy('org:policy:read', (req) => `org:${req.params.orgId}`),
    validate({ params: policyRulePathParamsSchema }),
    (req: Request, res: Response) => {
      const validatedReq = req as ValidatedRequest<PolicyRulePathParams>
      const rule = policyService.getRule(validatedReq.validated.params.ruleId)
      if (!rule) {
        res.status(404).json({ error: 'Rule not found' })
        return
      }
      res.json({ success: true, data: rule })
    },
  )

  // PATCH /api/orgs/:orgId/policies/:ruleId
  router.patch(
    '/:ruleId',
    requireUserAuth,
    requireAdminRole,
    validate({ params: policyRulePathParamsSchema, body: updatePolicyBodySchema }),
    (req: Request, res: Response) => {
      const validatedReq = req as ValidatedRequest<PolicyRulePathParams, any, UpdatePolicyBody>
      const authReq = req as unknown as AuthenticatedRequest
      try {
        const user = authReq.user!
        const rule = policyService.updateRule(
          user.tenantId,
          user.id,
          user.email,
          validatedReq.validated.params.ruleId,
          validatedReq.validated.body,
        )
        res.json({ success: true, data: rule })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        res.status(msg.includes('not found') ? 404 : 500).json({ error: msg })
      }
    },
  )

  // DELETE /api/orgs/:orgId/policies/:ruleId
  router.delete(
    '/:ruleId',
    requireUserAuth,
    requireAdminRole,
    validate({ params: policyRulePathParamsSchema }),
    (req: Request, res: Response) => {
      const validatedReq = req as ValidatedRequest<PolicyRulePathParams>
      const authReq = req as unknown as AuthenticatedRequest
      try {
        const user = authReq.user!
        policyService.deleteRule(user.tenantId, user.id, user.email, validatedReq.validated.params.ruleId)
        res.status(204).send()
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        res.status(msg.includes('not found') ? 404 : 500).json({ error: msg })
      }
    },
  )

  return router
}
