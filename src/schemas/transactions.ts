import { z } from 'zod'

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
  cursor: z.string().optional(),
  bondId: z.string().optional(),
}).strict()

export type TransactionsHistoryQuery = z.infer<typeof transactionsHistoryQuerySchema>
