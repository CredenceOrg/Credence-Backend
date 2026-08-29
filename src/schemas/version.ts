import { z } from './openapi.js'

/**
 * Response body for GET /api/version.
 *
 * @openapi VersionResponse
 */
export const versionResponseSchema = z
  .object({
    service: z.string().openapi({ example: 'credence-backend' }),
    gitSha: z.string().openapi({ example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' }),
    buildTimestamp: z.string().openapi({ example: '2026-06-25T20:00:00.000Z' }),
    nodeVersion: z.string().openapi({ example: 'v20.10.0' }),
  })
  .openapi('VersionResponse')

export type VersionResponse = z.infer<typeof versionResponseSchema>
