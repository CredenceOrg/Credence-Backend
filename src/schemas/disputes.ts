import { z } from './openapi.js'

const STELLAR_ADDRESS_EXAMPLE = 'GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX'

/**
 * Lifecycle status of a dispute, driven by the dispute state machine.
 * Valid transitions: pending -> under_review|resolved|dismissed|expired,
 * under_review -> resolved|dismissed|expired.
 */
export const disputeStatusSchema = z
  .enum(['pending', 'under_review', 'resolved', 'dismissed', 'expired'])
  .openapi('DisputeStatus')

/**
 * Body schema for POST /api/disputes
 */
export const submitDisputeBodySchema = z
  .object({
    filedBy: z
      .string()
      .regex(/^G[A-Z2-7]{55}$/, 'filedBy must be a valid Stellar address')
      .openapi({
        description: 'Stellar address of the party filing the dispute',
        example: STELLAR_ADDRESS_EXAMPLE,
      }),
    respondent: z
      .string()
      .regex(/^G[A-Z2-7]{55}$/, 'respondent must be a valid Stellar address')
      .openapi({
        description: 'Stellar address of the respondent',
        example: 'GBVFLWXYZ6JJ7TUSU6QDJ6DOY4J5G5VHGJWSCMHL7QSAHRDEQU3EXFW2',
      }),
    reason: z.string().min(10).openapi({
      description: 'Reason for the dispute (minimum 10 characters)',
      example: 'Goods delivered did not match the agreed specification',
    }),
    evidence: z.array(z.string()).min(1).openapi({
      description: 'Evidence references (URIs, hashes, etc.) supporting the dispute',
      example: ['ipfs://bafybeih...'],
    }),
    deadlineMs: z
      .number()
      .int()
      .min(60 * 60 * 1000)
      .max(30 * 24 * 60 * 60 * 1000)
      .openapi({
        description:
          'Resolution deadline expressed as milliseconds from now (min 1 hour, max 30 days)',
        example: 86400000,
      }),
  })
  .openapi('SubmitDisputeBody')

/**
 * Response schema for dispute endpoints (submit/get/review/resolve/dismiss).
 */
export const disputeSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '5f8d0d55-1c1b-4e9a-9b1a-4e6f6f6f6f6f' }),
    filedBy: z.string().openapi({ example: STELLAR_ADDRESS_EXAMPLE }),
    respondent: z.string().openapi({
      example: 'GBVFLWXYZ6JJ7TUSU6QDJ6DOY4J5G5VHGJWSCMHL7QSAHRDEQU3EXFW2',
    }),
    reason: z.string().openapi({
      example: 'Goods delivered did not match the agreed specification',
    }),
    evidence: z.array(z.string()).openapi({ example: ['ipfs://bafybeih...'] }),
    status: disputeStatusSchema,
    createdAt: z.string().datetime().openapi({ example: '2024-01-15T09:00:00.000Z' }),
    deadline: z.string().datetime().openapi({ example: '2024-01-16T09:00:00.000Z' }),
    resolution: z.string().nullable().openapi({ example: null }),
  })
  .openapi('Dispute')

/**
 * Path params shared by /api/disputes/:id routes.
 */
export const disputePathParamsSchema = z
  .object({
    id: z.string().uuid().openapi({
      description: 'Dispute ID',
      example: '5f8d0d55-1c1b-4e9a-9b1a-4e6f6f6f6f6f',
    }),
  })
  .openapi('DisputePathParams')

/**
 * Body schema for POST /api/disputes/:id/resolve
 */
export const resolveDisputeBodySchema = z
  .object({
    resolution: z.string().min(1).openapi({
      description: 'Resolution text describing the outcome',
      example: 'Respondent agreed to a partial refund of 20%',
    }),
  })
  .openapi('ResolveDisputeBody')

/**
 * Body schema for POST /api/disputes/:id/dismiss
 */
export const dismissDisputeBodySchema = z
  .object({
    reason: z.string().min(1).openapi({
      description: 'Reason the dispute is being dismissed',
      example: 'Insufficient evidence provided',
    }),
  })
  .openapi('DismissDisputeBody')

/**
 * Standard error response for dispute endpoints (400/404).
 */
export const disputeErrorSchema = z
  .object({
    error: z.string().openapi({ example: 'NotFound' }),
    message: z.string().openapi({ example: 'Dispute not found' }),
  })
  .openapi('DisputeError')

/**
 * Error response for invalid dispute state transitions (422), e.g. resolving
 * an already-resolved dispute or reviewing an expired one.
 */
export const disputeTransitionErrorSchema = z
  .object({
    error: z.string().openapi({ example: 'Invalid dispute state transition' }),
    code: z.string().openapi({ example: 'invalid_dispute_transition' }),
    error_code: z.string().openapi({ example: 'invalid_dispute_transition' }),
    message: z.string().openapi({ example: 'Invalid transition from "resolved" to "resolved"' }),
  })
  .openapi('DisputeTransitionError')

export type DisputeStatus = z.infer<typeof disputeStatusSchema>
export type SubmitDisputeBody = z.infer<typeof submitDisputeBodySchema>
export type DisputeResponse = z.infer<typeof disputeSchema>
export type DisputePathParams = z.infer<typeof disputePathParamsSchema>
export type ResolveDisputeBody = z.infer<typeof resolveDisputeBodySchema>
export type DismissDisputeBody = z.infer<typeof dismissDisputeBodySchema>
