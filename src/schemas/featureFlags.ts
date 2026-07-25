import { z } from './openapi.js'
import { ROLLOUT_PERCENT_MIN, ROLLOUT_PERCENT_MAX } from '../services/featureFlags/consts.js'

// ── Reusable primitives ───────────────────────────────────────────────────────

export const flagKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/, 'Flag key must contain only lowercase letters, digits, hyphens, and underscores')
  .openapi({ description: 'Unique flag identifier (slug)', example: 'new-scoring-weights' })

export const rolloutPercentSchema = z
  .number()
  .int()
  .min(ROLLOUT_PERCENT_MIN)
  .max(ROLLOUT_PERCENT_MAX)
  .openapi({
    description: `Rollout percentage (${ROLLOUT_PERCENT_MIN}–${ROLLOUT_PERCENT_MAX}). 0 = disabled for all, 100 = enabled for all.`,
    example: 25,
  })

// ── Request schemas ───────────────────────────────────────────────────────────

/** POST /api/admin/feature-flags */
export const createFlagBodySchema = z
  .object({
    key: flagKeySchema,
    description: z.string().max(512).default('').openapi({
      description: 'Human-readable description of the flag',
      example: 'Enable new scoring algorithm for gradual rollout',
    }),
    defaultEnabled: z.boolean().default(false).openapi({
      description: 'Default enabled state when no override or rollout applies',
      example: false,
    }),
    rolloutPercent: rolloutPercentSchema.default(0),
  })
  .openapi('CreateFlagBody')

/** PUT /api/admin/feature-flags/:key */
export const updateFlagBodySchema = z
  .object({
    description: z.string().max(512).optional().openapi({
      description: 'New description for the flag',
      example: 'Updated description',
    }),
    defaultEnabled: z.boolean().optional().openapi({
      description: 'New default enabled state',
      example: true,
    }),
    rolloutPercent: rolloutPercentSchema.optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: 'At least one field must be provided' },
  )
  .openapi('UpdateFlagBody')

/** POST /api/admin/feature-flags/:key/overrides */
export const setOverrideBodySchema = z
  .object({
    tenantId: z.string().min(1).max(256).openapi({
      description: 'Tenant identifier to apply the override to',
      example: 'tenant-abc',
    }),
    enabled: z.boolean().openapi({
      description: 'Whether the flag is enabled for this tenant (overrides rollout)',
      example: true,
    }),
  })
  .openapi('SetOverrideBody')

/**
 * POST /api/admin/feature-flags/:key/tenant-rollouts
 *
 * Sets a per-tenant rollout percentage.  Unlike a boolean override this allows
 * the same flag to roll out at different speeds per tenant while still using
 * sticky user-id bucketing within each tenant.
 */
export const setTenantRolloutBodySchema = z
  .object({
    tenantId: z.string().min(1).max(256).openapi({
      description: 'Tenant identifier to apply the per-tenant rollout to',
      example: 'tenant-abc',
    }),
    rolloutPercent: rolloutPercentSchema,
  })
  .openapi('SetTenantRolloutBody')

/** Path params: /:key */
export const flagKeyParamsSchema = z
  .object({
    key: flagKeySchema,
  })
  .openapi('FlagKeyParams')

/** Path params: /:key/overrides/:tenantId and /:key/tenant-rollouts/:tenantId */
export const flagKeyTenantParamsSchema = z
  .object({
    key: flagKeySchema,
    tenantId: z.string().min(1).max(256).openapi({
      description: 'Tenant identifier',
      example: 'tenant-abc',
    }),
  })
  .openapi('FlagKeyTenantParams')

// ── Response schemas ──────────────────────────────────────────────────────────

export const featureFlagResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
    key: flagKeySchema,
    description: z.string().openapi({ example: 'Enable new scoring algorithm' }),
    defaultEnabled: z.boolean().openapi({ example: false }),
    rolloutPercent: rolloutPercentSchema,
    createdAt: z.string().datetime().openapi({ example: '2025-01-01T00:00:00.000Z' }),
    updatedAt: z.string().datetime().openapi({ example: '2025-01-15T12:00:00.000Z' }),
  })
  .openapi('FeatureFlagResponse')

export const featureFlagOverrideResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '5d7e4a12-0a3b-4c9d-bf82-1e2f3a4b5c6d' }),
    flagId: z.string().uuid().openapi({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
    tenantId: z.string().openapi({ example: 'tenant-abc' }),
    enabled: z.boolean().openapi({ example: true }),
    createdAt: z.string().datetime().openapi({ example: '2025-01-01T00:00:00.000Z' }),
    updatedAt: z.string().datetime().openapi({ example: '2025-01-15T12:00:00.000Z' }),
  })
  .openapi('FeatureFlagOverrideResponse')

export const featureFlagTenantRolloutResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
    flagId: z.string().uuid().openapi({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
    tenantId: z.string().openapi({ example: 'tenant-abc' }),
    rolloutPercent: rolloutPercentSchema,
    createdAt: z.string().datetime().openapi({ example: '2025-01-01T00:00:00.000Z' }),
    updatedAt: z.string().datetime().openapi({ example: '2025-01-15T12:00:00.000Z' }),
  })
  .openapi('FeatureFlagTenantRolloutResponse')

export const featureFlagWithOverrideResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
    key: flagKeySchema,
    description: z.string().openapi({ example: 'Enable new scoring algorithm' }),
    defaultEnabled: z.boolean().openapi({ example: false }),
    rolloutPercent: rolloutPercentSchema,
    createdAt: z.string().datetime().openapi({ example: '2025-01-01T00:00:00.000Z' }),
    updatedAt: z.string().datetime().openapi({ example: '2025-01-15T12:00:00.000Z' }),
    override: featureFlagOverrideResponseSchema.nullable().openapi({
      description: 'Per-tenant boolean override, if set',
    }),
    tenantRollout: featureFlagTenantRolloutResponseSchema.nullable().openapi({
      description: 'Per-tenant rollout percentage override, if set',
    }),
    effectiveEnabled: z.boolean().openapi({
      description:
        'Resolved enabled state for the current tenant (accounts for override, per-tenant rollout, global rollout, and default)',
      example: true,
    }),
    effectiveRolloutPercent: rolloutPercentSchema.openapi({
      description:
        'Effective rollout percentage used for user-level sticky bucketing (per-tenant rollout takes precedence over global)',
      example: 25,
    }),
  })
  .openapi('FeatureFlagWithOverrideResponse')

export const flagListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(featureFlagWithOverrideResponseSchema),
  })
  .openapi('FlagListResponse')

export const flagResponseEnvelopeSchema = z
  .object({
    success: z.literal(true),
    data: featureFlagResponseSchema,
  })
  .openapi('FlagResponseEnvelope')

export const overrideResponseEnvelopeSchema = z
  .object({
    success: z.literal(true),
    data: featureFlagOverrideResponseSchema,
  })
  .openapi('OverrideResponseEnvelope')

export const tenantRolloutResponseEnvelopeSchema = z
  .object({
    success: z.literal(true),
    data: featureFlagTenantRolloutResponseSchema,
  })
  .openapi('TenantRolloutResponseEnvelope')

export const flagErrorResponseSchema = z
  .object({
    error: z.string().openapi({ example: "Feature flag 'unknown-flag' not found" }),
  })
  .openapi('FlagErrorResponse')

// ── TypeScript types inferred from schemas ────────────────────────────────────

export type CreateFlagBody = z.infer<typeof createFlagBodySchema>
export type UpdateFlagBody = z.infer<typeof updateFlagBodySchema>
export type SetOverrideBody = z.infer<typeof setOverrideBodySchema>
export type SetTenantRolloutBody = z.infer<typeof setTenantRolloutBodySchema>
export type FlagKeyParams = z.infer<typeof flagKeyParamsSchema>
export type FlagKeyTenantParams = z.infer<typeof flagKeyTenantParamsSchema>
export type FeatureFlagResponse = z.infer<typeof featureFlagResponseSchema>
export type FeatureFlagOverrideResponse = z.infer<typeof featureFlagOverrideResponseSchema>
export type FeatureFlagTenantRolloutResponse = z.infer<typeof featureFlagTenantRolloutResponseSchema>
export type FeatureFlagWithOverrideResponse = z.infer<typeof featureFlagWithOverrideResponseSchema>
