import { z } from 'zod'

export const setRateLimitOverrideBodySchema = z.object({
  tenantId: z.string().min(1, 'tenantId is required'),
  rateLimit: z.number().int().min(1, 'rateLimit must be a positive integer'),
  windowSize: z.number().int().min(1, 'windowSize must be a positive integer in seconds'),
  reason: z.string().min(3, 'reason is required and must be at least 3 characters'),
})

export const removeRateLimitOverrideBodySchema = z.object({
  reason: z.string().min(3, 'reason is required and must be at least 3 characters'),
})

export const rateLimitOverrideSchema = z.object({
  id: z.number().optional(),
  tenantId: z.string(),
  rateLimit: z.number(),
  windowSize: z.number(),
  reason: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

export const setRateLimitOverrideResponseSchema = z.object({
  success: z.boolean(),
  data: rateLimitOverrideSchema,
})

export const listRateLimitOverridesResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(rateLimitOverrideSchema),
})

export type SetRateLimitOverrideBody = z.infer<typeof setRateLimitOverrideBodySchema>
export type RemoveRateLimitOverrideBody = z.infer<typeof removeRateLimitOverrideBodySchema>
export type RateLimitOverrideDto = z.infer<typeof rateLimitOverrideSchema>
