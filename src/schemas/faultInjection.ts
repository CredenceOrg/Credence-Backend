import { z } from './openapi.js'

/**
 * Request body for POST /api/dev/fault-injection.
 *
 * @openapi FaultInjectionRequest
 */
export const faultInjectionRequestSchema = z
  .object({
    /** HTTP status code to return (default: 500). */
    statusCode: z
      .number()
      .int()
      .min(400)
      .max(599)
      .default(500)
      .openapi({ example: 500 }),
    /** Optional message to include in the error response body. */
    message: z
      .string()
      .max(512)
      .optional()
      .openapi({ example: 'Simulated fault for retry testing' }),
  })
  .openapi('FaultInjectionRequest')

export type FaultInjectionRequest = z.infer<typeof faultInjectionRequestSchema>

/**
 * Response body for POST /api/dev/fault-injection.
 *
 * @openapi FaultInjectionResponse
 */
export const faultInjectionResponseSchema = z
  .object({
    fault: z.literal(true),
    statusCode: z.number().int().openapi({ example: 500 }),
    message: z.string().openapi({ example: 'Simulated fault for retry testing' }),
  })
  .openapi('FaultInjectionResponse')

export type FaultInjectionResponse = z.infer<typeof faultInjectionResponseSchema>
