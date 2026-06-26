import { z } from './openapi.js';

export const DashboardSnapshotSchema = z
  .object({
    generatedAt: z.string().openapi({ description: 'ISO-8601 timestamp when the snapshot was assembled', format: 'date-time' }),
    health: z
      .object({
        status: z.enum(['ok', 'degraded', 'unhealthy']),
        dependencies: z.record(z.string(), z.object({ status: z.string() })).optional(),
      })
      .openapi({ description: 'Service health summary' }),
    analytics: z
      .object({
        activeIdentities: z.number().int().nonnegative(),
        totalIdentities: z.number().int().nonnegative(),
        avgTotalScore: z.number(),
        fresh: z.boolean(),
      })
      .nullable()
      .openapi({ description: 'Latest analytics metrics, null when analytics are unavailable' }),
  })
  .openapi('DashboardSnapshot');

export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>;
