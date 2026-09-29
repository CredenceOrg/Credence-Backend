import { z } from './openapi.js'

/**
 * Zod schema for the X-Correlation-ID request header.
 *
 * @openapi CorrelationIdHeader
 */
export const correlationIdHeaderSchema = z
  .string()
  .uuid()
  .openapi({
    param: {
      name: 'X-Correlation-ID',
      in: 'header',
      required: false,
      description:
        'Caller-supplied correlation ID that is propagated across all downstream ' +
        'services. When absent, the server generates a UUID v4 automatically.',
      example: 'd290f1ee-6c54-4b01-90e6-d701748f0851',
    },
  })

export type CorrelationIdHeader = z.infer<typeof correlationIdHeaderSchema>
