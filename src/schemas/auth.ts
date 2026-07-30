import { z } from 'zod'

export const authLoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantId: z.string().min(1).optional(),
})

export const authRefreshBodySchema = z.object({
  refreshToken: z.string().min(1),
  tenantId: z.string().min(1).optional(),
})

export type AuthLoginBody = z.infer<typeof authLoginBodySchema>
export type AuthRefreshBody = z.infer<typeof authRefreshBodySchema>
