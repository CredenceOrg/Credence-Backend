import { z } from 'zod'
import { decodeCursor, type DecodedCursor } from '../lib/pagination.js'

/**
 * Query schema for GET /api/transactions/history
 */
export const transactionsHistoryQuerySchema = z.object({
  limit: z.preprocess((val) => {
    if (typeof val === 'string' && val.trim() !== '') {
      const num = parseInt(val, 10)
      if (!isNaN(num)) return num
    }
    return val;
  }, z.number().int().min(1).max(100).optional()),
  cursor: z
    .string()
    .optional()
    .transform((cursor, ctx) => {
      if (!cursor) return undefined

      const decoded = decodeCursor(cursor)
      if (!decoded) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid cursor format',
        })
        return z.NEVER
      }

      return decoded
    }),
  bondId: z.string().optional(),
}).strict()

export interface TransactionsHistoryQuery {
  limit?: number
  cursor?: DecodedCursor
  bondId?: string
}
