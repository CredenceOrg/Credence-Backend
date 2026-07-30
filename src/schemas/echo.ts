import { z } from 'zod'

const headerValueSchema = z.union([z.string(), z.array(z.string())])

export const echoResponseSchema = z.object({
  headers: z.record(z.string(), headerValueSchema),
})

export type EchoResponse = z.infer<typeof echoResponseSchema>
