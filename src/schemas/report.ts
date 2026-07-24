import { z } from 'zod'

/**
 * Allowed report types — single source of truth for the route and worker.
 * Add new report types here as they are implemented.
 */
export const REPORT_TYPES = [
  'trust_score_summary',
  'bond_audit',
  'attestation_export',
  'top_talkers',
] as const

/**
 * Schema for a valid report type string.
 */
export const reportTypeSchema = z.enum(REPORT_TYPES)

/**
 * Body schema for POST /api/reports
 */
export const createReportBodySchema = z
  .object({
    type: reportTypeSchema,
  })
  .strict()

export type ReportType = z.infer<typeof reportTypeSchema>
export type CreateReportBody = z.infer<typeof createReportBodySchema>

/**
 * Path params for GET /api/reports/:jobId
 */
export const reportJobParamsSchema = z.object({
  jobId: z.string().min(1, 'jobId is required'),
})

export type ReportJobParams = z.infer<typeof reportJobParamsSchema>

/**
 * Query schema for GET /api/reports/top-talkers
 */
export const topTalkersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  windowMinutes: z.coerce.number().int().min(1).max(1440).optional(),
})

export const topTalkerEntrySchema = z.object({
  tenantId: z.string(),
  requestCount: z.number(),
  percentage: z.number(),
  lastRequestAt: z.string().optional(),
})

export const topTalkersResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    windowStart: z.string(),
    windowEnd: z.string(),
    windowMinutes: z.number(),
    totalRequests: z.number(),
    topTalkers: z.array(topTalkerEntrySchema),
  }),
})

export type TopTalkersQuery = z.infer<typeof topTalkersQuerySchema>
export type TopTalkersResponse = z.infer<typeof topTalkersResponseSchema>

