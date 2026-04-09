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

import { Router, Request, Response } from 'express'
import { requireUserAuth, requireAdminRole } from '../middleware/auth.js'
import { requirePolicy } from '../middleware/policy.js'
import { policyService } from '../services/policy/service.js'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import type { CreatePolicyRuleInput } from '../services/policy/types.js'

export function createPolicyRouter(): Router {
  const router = Router({ mergeParams: true })

  // POST /api/orgs/:orgId/policies
  router.post(
    '/',
    requireUserAuth,
    requireAdminRole,
    (req: Request, res: Response) => {
      const authReq = req as AuthenticatedRequest
      const { orgId } = req.params
      const body = req.body as Partial<CreatePolicyRuleInput>

      if (!body.subject || !body.action || !body.resource || !body.effect) {
        res.status(400).json({ error: 'Missing required fields: subject, action, resource, effect' })
        return
      }

      try {
        const rule = policyService.createRule(authReq.user!.id, authReq.user!.email, {
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
    (req: Request, res: Response) => {
      const rules = policyService.listRules(req.params.orgId)
      res.json({ success: true, data: rules })
    },
  )

  // GET /api/orgs/:orgId/policies/:ruleId
  router.get(
    '/:ruleId',
    requireUserAuth,
    requirePolicy('org:policy:read', (req) => `org:${req.params.orgId}`),
    (req: Request, res: Response) => {
      const rule = policyService.getRule(req.params.ruleId)
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
    (req: Request, res: Response) => {
      const authReq = req as AuthenticatedRequest
      try {
        const rule = policyService.updateRule(
          authReq.user!.id,
          authReq.user!.email,
          req.params.ruleId,
          req.body,
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
    (req: Request, res: Response) => {
      const authReq = req as AuthenticatedRequest
      try {
        policyService.deleteRule(authReq.user!.id, authReq.user!.email, req.params.ruleId)
        res.status(204).send()
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        res.status(msg.includes('not found') ? 404 : 500).json({ error: msg })
      }
    },
  )

  return router
}
