import { z } from 'zod'

/**
 * Path params for policy routes.
 * POST/GET  /api/orgs/:orgId/policies
 * GET/PATCH/DELETE /api/orgs/:orgId/policies/:ruleId
 */
export const policyOrgPathParamsSchema = z.object({
  orgId: z.string().min(1, 'orgId is required'),
})

export const policyRulePathParamsSchema = z.object({
  orgId: z.string().min(1, 'orgId is required'),
  ruleId: z.string().min(1, 'ruleId is required'),
})

/**
 * Body schema for POST /api/orgs/:orgId/policies
 * Creates a new policy rule.
 */
export const createPolicyBodySchema = z
  .object({
    subject: z.string().min(1, 'subject is required'),
    action: z.enum([
      'org:read',
      'org:update',
      'org:delete',
      'org:member:invite',
      'org:member:remove',
      'org:member:list',
      'org:role:assign',
      'org:apikey:create',
      'org:apikey:revoke',
      'org:apikey:list',
      'org:audit:read',
      'org:policy:read',
      'org:policy:write',
      '*',
    ]),
    resource: z.string().min(1, 'resource is required'),
    effect: z.enum(['allow', 'deny']),
    conditions: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
  })
  .strict()

/**
 * Body schema for PATCH /api/orgs/:orgId/policies/:ruleId
 * Updates an existing rule (all fields optional).
 */
export const updatePolicyBodySchema = z
  .object({
    subject: z.string().min(1).optional(),
    action: z
      .enum([
        'org:read',
        'org:update',
        'org:delete',
        'org:member:invite',
        'org:member:remove',
        'org:member:list',
        'org:role:assign',
        'org:apikey:create',
        'org:apikey:revoke',
        'org:apikey:list',
        'org:audit:read',
        'org:policy:read',
        'org:policy:write',
        '*',
      ])
      .optional(),
    resource: z.string().min(1).optional(),
    effect: z.enum(['allow', 'deny']).optional(),
    conditions: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
  })
  .strict()

/**
 * Query params for GET /api/orgs/:orgId/policies
 */
export const policyListQuerySchema = z.object({
  page: z.preprocess((v) => (typeof v === 'string' ? parseInt(v, 10) : v), z.number().int().positive().optional()),
  limit: z.preprocess((v) => (typeof v === 'string' ? parseInt(v, 10) : v), z.number().int().positive().max(100).optional()),
})

export type PolicyOrgPathParams = z.infer<typeof policyOrgPathParamsSchema>
export type PolicyRulePathParams = z.infer<typeof policyRulePathParamsSchema>
export type CreatePolicyBody = z.infer<typeof createPolicyBodySchema>
export type UpdatePolicyBody = z.infer<typeof updatePolicyBodySchema>
export type PolicyListQuery = z.infer<typeof policyListQuerySchema>
