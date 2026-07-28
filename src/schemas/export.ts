import { z } from 'zod'

// ISO-8601 datetime regex — covers `2024-01-15T10:30:00Z` and offset variants.
const iso8601Regex =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Query schema for GET /api/export/audit-logs
 */
export const auditLogExportQuerySchema = z.object({
  from: z
    .string()
    .regex(iso8601Regex, 'from must be a valid ISO-8601 datetime string')
    .optional(),
  to: z
    .string()
    .regex(iso8601Regex, 'to must be a valid ISO-8601 datetime string')
    .optional(),
})

export type AuditLogExportQuery = z.infer<typeof auditLogExportQuerySchema>
