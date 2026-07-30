import { z } from './openapi.js'

/**
 * Query params for GET /api/admin/settlement/reconciliation.
 *
 * @openapi SettlementReconciliationQuery
 */
export const settlementReconciliationQuerySchema = z
  .object({
    cursor: z
      .string()
      .optional()
      .openapi({
        description: 'Opaque cursor returned from a previous page',
        example: 'eyJ0IjoiMjAyNi...',
      }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .optional()
      .openapi({
        description: 'Maximum number of findings to return per page (1–100, default 20)',
        example: 20,
      }),
  })
  .strict()
  .openapi('SettlementReconciliationQuery')

/**
 * Summary of a single reconciliation run.
 *
 * @openapi ReconciliationRunSummary
 */
export const reconciliationRunSummarySchema = z
  .object({
    checked: z.number().int().min(0).openapi({
      description: 'Number of settlements checked against the ledger',
      example: 42,
    }),
    discrepancies: z.number().int().min(0).openapi({
      description: 'Number of settlements with a ledger mismatch',
      example: 2,
    }),
    errors: z.number().int().min(0).openapi({
      description: 'Number of settlements that could not be verified due to errors',
      example: 0,
    }),
    runAt: z.string().datetime().openapi({
      description: 'ISO 8601 timestamp of when the reconciliation run completed',
      example: '2026-06-30T12:00:00.000Z',
    }),
  })
  .openapi('ReconciliationRunSummary')

/**
 * A single reconciliation finding (unmatched record).
 *
 * @openapi ReconciliationFinding
 */
export const reconciliationFindingSchema = z
  .object({
    id: z.string().uuid().openapi({
      description: 'Unique identifier for this finding',
    }),
    settlementId: z.string().uuid().openapi({
      description: 'ID of the settlement that has a discrepancy',
    }),
    findingType: z.string().openapi({
      description: 'Type of discrepancy: state_mismatch or missing_on_chain',
      example: 'state_mismatch',
    }),
    details: z.record(z.string(), z.unknown()).openapi({
      description: 'Structured details about the discrepancy',
    }),
    createdAt: z.string().datetime().openapi({
      description: 'ISO 8601 timestamp of when the finding was recorded',
    }),
  })
  .openapi('ReconciliationFinding')

/**
 * Full response envelope for the reconciliation endpoint.
 *
 * @openapi SettlementReconciliationResponse
 */
export const settlementReconciliationResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        summary: reconciliationRunSummarySchema,
        findings: z.object({
          data: z.array(reconciliationFindingSchema),
          page: z.object({
            nextCursor: z.string().nullable(),
            hasMore: z.boolean(),
            limit: z.number().int(),
          }),
        }),
      })
      .nullable(),
  })
  .openapi('SettlementReconciliationResponse')

export type SettlementReconciliationQuery = z.infer<typeof settlementReconciliationQuerySchema>
export type ReconciliationRunSummary = z.infer<typeof reconciliationRunSummarySchema>
export type ReconciliationFinding = z.infer<typeof reconciliationFindingSchema>
