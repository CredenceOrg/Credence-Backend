import { z } from 'zod'

/**
 * Schema for a single worker health entry returned by `GET /api/health/workers`.
 */
export const workerHealthEntrySchema = z.object({
  /** Friendly worker name (e.g. "score-snapshot"). */
  name: z.string(),
  /** Redis lock key (e.g. "cron:score-snapshot"). */
  lockKey: z.string(),
  /** Whether a worker currently holds the lock. */
  held: z.boolean(),
  /** ISO 8601 timestamp when the lock was acquired (extracted from token). */
  acquiredAt: z.string().nullable(),
  /** Process ID that acquired the lock (extracted from token). */
  pid: z.number().nullable(),
  /** Remaining TTL in milliseconds. -1 if no expiry, -2 if key gone. */
  ttlMs: z.number(),
})

/**
 * Schema for the full `GET /api/health/workers` response.
 */
export const workerHealthResponseSchema = z.object({
  /** Array of worker lock states. */
  workers: z.array(workerHealthEntrySchema),
})

export type WorkerHealthEntry = z.infer<typeof workerHealthEntrySchema>
export type WorkerHealthResponse = z.infer<typeof workerHealthResponseSchema>
