import { z } from 'zod'

/**
 * Payload emitted when an org's remaining credits cross the configured low-water threshold.
 */
export const creditsLowWebhookPayloadSchema = z.object({
  orgId: z.string().uuid(),
  creditsRemaining: z.number().int().nonnegative(),
  threshold: z.number().int().nonnegative(),
  endpoint: z.string().optional(),
  requestId: z.string().optional(),
})

export type CreditsLowWebhookPayload = z.infer<typeof creditsLowWebhookPayloadSchema>
