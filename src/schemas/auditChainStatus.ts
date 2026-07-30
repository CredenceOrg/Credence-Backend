import { z } from './openapi.js'

/**
 * Query params for GET /api/admin/audit/chain-status (read-only, no filters).
 */
export const auditChainStatusQuerySchema = z
  .object({})
  .strict()
  .openapi('AuditChainStatusQuery')

export const auditChainVerificationStatusSchema = z
  .enum(['valid', 'break_detected', 'never_run'])
  .openapi('AuditChainVerificationStatus')

export const auditChainStatusResponseSchema = z
  .object({
    lastVerifiedHeight: z.number().int().min(0).openapi({
      description: 'Highest sequence number verified as intact',
      example: 42,
    }),
    verifiedAt: z.string().datetime().nullable().openapi({
      description: 'ISO timestamp of the last verification run',
      example: '2025-06-01T12:00:00.000Z',
    }),
    status: auditChainVerificationStatusSchema.openapi({
      description: 'Outcome of the last verification run',
    }),
    firstBreakSeq: z.number().int().min(0).nullable().optional().openapi({
      description: 'Sequence number of the first detected chain break, if any',
      example: 3,
    }),
    violationCount: z.number().int().min(0).optional().openapi({ example: 0 }),
    rowsChecked: z.number().int().min(0).optional().openapi({ example: 42 }),
  })
  .openapi('AuditChainStatusResponse')

export type AuditChainStatusQuery = z.infer<typeof auditChainStatusQuerySchema>
export type AuditChainStatusResponse = z.infer<typeof auditChainStatusResponseSchema>
