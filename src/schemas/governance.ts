import { z } from './openapi.js'

/**
 * Vote choice cast by a signer on a slash request.
 */
export const voteChoiceSchema = z.enum(['approve', 'reject']).openapi('VoteChoice')

/**
 * Lifecycle status of a slash request, derived from cast votes vs. threshold.
 */
export const slashRequestStatusSchema = z
  .enum(['pending', 'approved', 'rejected'])
  .openapi('SlashRequestStatus')

/**
 * Body schema for POST /api/governance/slash-requests
 */
export const createSlashRequestBodySchema = z
  .object({
    targetAddress: z.string().min(1).openapi({
      description: 'On-chain address of the entity being slashed',
      example: 'GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX',
    }),
    reason: z.string().min(1).openapi({
      description: 'Reason for requesting the slash',
      example: 'Repeated SLA violations on delivery commitments',
    }),
    requestedBy: z.string().min(1).openapi({
      description: 'Identifier of the requester',
      example: 'validator-12',
    }),
    threshold: z.number().int().min(1).optional().openapi({
      description: 'Approve votes required to pass (default: 3)',
      example: 3,
    }),
    totalSigners: z.number().int().min(1).optional().openapi({
      description: 'Total eligible signers (default: 5)',
      example: 5,
    }),
  })
  .openapi('CreateSlashRequestBody')

/**
 * A single cast vote on a slash request.
 */
export const voteSchema = z
  .object({
    voterId: z.string().openapi({ example: 'validator-3' }),
    choice: voteChoiceSchema,
    timestamp: z.string().datetime().openapi({
      description: 'ISO 8601 timestamp the vote was cast',
      example: '2024-01-15T10:00:00.000Z',
    }),
  })
  .openapi('Vote')

/**
 * Response schema for slash request endpoints (create/get/list item).
 */
export const slashRequestSchema = z
  .object({
    id: z.string().openapi({ example: 'a1b2c3d4e5f6a7b8' }),
    targetAddress: z.string().openapi({
      example: 'GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX',
    }),
    reason: z.string().openapi({ example: 'Repeated SLA violations on delivery commitments' }),
    requestedBy: z.string().openapi({ example: 'validator-12' }),
    createdAt: z.string().datetime().openapi({ example: '2024-01-15T09:00:00.000Z' }),
    votes: z.array(voteSchema),
    status: slashRequestStatusSchema,
    threshold: z.number().int().openapi({ example: 3 }),
    totalSigners: z.number().int().openapi({ example: 5 }),
  })
  .openapi('SlashRequest')

/**
 * Path params shared by /api/governance/slash-requests/:id routes.
 */
export const slashRequestPathParamsSchema = z
  .object({
    id: z.string().openapi({
      description: 'Slash request ID',
      example: 'a1b2c3d4e5f6a7b8',
    }),
  })
  .openapi('SlashRequestPathParams')

/**
 * Body schema for POST /api/governance/slash-requests/:id/votes
 */
export const submitVoteBodySchema = z
  .object({
    voterId: z.string().min(1).openapi({ example: 'validator-3' }),
    choice: voteChoiceSchema,
  })
  .openapi('SubmitVoteBody')

/**
 * Response schema for POST /api/governance/slash-requests/:id/votes
 */
export const voteResultSchema = z
  .object({
    slashRequestId: z.string().openapi({ example: 'a1b2c3d4e5f6a7b8' }),
    voterId: z.string().openapi({ example: 'validator-3' }),
    choice: voteChoiceSchema,
    approveCount: z.number().int().openapi({ example: 2 }),
    rejectCount: z.number().int().openapi({ example: 0 }),
    status: slashRequestStatusSchema,
  })
  .openapi('VoteResult')

/**
 * Query params for GET /api/governance/slash-requests
 */
export const slashRequestsQuerySchema = z
  .object({
    status: slashRequestStatusSchema.optional(),
    page: z.coerce.number().int().min(1).optional().openapi({ example: 1 }),
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi('SlashRequestsQuery')

/**
 * Response schema for GET /api/governance/slash-requests (paginated list)
 */
export const slashRequestsListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(slashRequestSchema),
    page: z.number().int().openapi({ example: 1 }),
    limit: z.number().int().openapi({ example: 20 }),
    total: z.number().int().openapi({ example: 1 }),
    hasNext: z.boolean().openapi({ example: false }),
  })
  .openapi('SlashRequestsListResponse')

/**
 * Standard error response for governance endpoints (400/404/409).
 */
export const governanceErrorSchema = z
  .object({
    error: z.string().openapi({ example: 'NotFound' }),
    message: z.string().openapi({ example: 'Slash request not found' }),
  })
  .openapi('GovernanceError')

export type VoteChoice = z.infer<typeof voteChoiceSchema>
export type SlashRequestStatus = z.infer<typeof slashRequestStatusSchema>
export type CreateSlashRequestBody = z.infer<typeof createSlashRequestBodySchema>
export type SlashRequestResponse = z.infer<typeof slashRequestSchema>
export type SlashRequestPathParams = z.infer<typeof slashRequestPathParamsSchema>
export type SubmitVoteBody = z.infer<typeof submitVoteBodySchema>
export type VoteResult = z.infer<typeof voteResultSchema>
export type SlashRequestsQuery = z.infer<typeof slashRequestsQuerySchema>
export type SlashRequestsListResponse = z.infer<typeof slashRequestsListResponseSchema>
