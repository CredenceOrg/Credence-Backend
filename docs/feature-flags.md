# Feature Flags

## Overview

The feature flag service provides per-tenant toggles for code paths that should be rolled out gradually across organizations. It supports four evaluation layers (in priority order):

1. **Per-tenant boolean override** — explicitly enables or disables a flag for a specific tenant, regardless of any rollout percentage
2. **Per-tenant rollout percent** — each tenant can have its own rollout percentage (0–100%), distinct from the global setting
3. **Global rollout percent** — a single percentage applied to all tenants that do not have a per-tenant rollout
4. **Default enabled** — fallback when none of the above applies

Sticky user-id bucketing (SHA-256 hash of `flagKey:userId`) applies at both rollout layers (per-tenant and global), so the same user always sees the same result for a given flag.

Every mutation (create, update, set/remove override, set/remove tenant rollout) writes an audit log entry and emits a transactional outbox event for cross-instance cache invalidation.

## Migration from pre-#570 versions

Issue #570 added **per-tenant rollout percentages** as a new concept. The existing API surface is fully backwards-compatible:

| Change | Impact |
|---|---|
| `FeatureFlagWithOverride` now includes `tenantRollout` and `effectiveRolloutPercent` fields | Non-breaking addition. Existing consumers that ignore unknown fields are unaffected. |
| Two new REST endpoints (`POST/DELETE …/tenant-rollouts`) | Additive. No existing endpoint was changed or removed. |
| New DB table `feature_flag_tenant_rollouts` (migration 020) | Additive. Existing tables untouched. |
| `computeRolloutBucket` is now exported | Non-breaking. Previously internal-only. |
| Constants moved to `src/services/featureFlags/consts.ts` | No runtime change. Internal refactor only. |

**Migration step for consumers** that expose `FeatureFlagWithOverride` to downstream clients: the response shape now includes two additional fields. If your downstream clients use strict JSON parsers that reject unknown keys, update them to accept `tenantRollout` (nullable object) and `effectiveRolloutPercent` (integer).

## Tables

### `feature_flags`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | Auto-generated |
| `key` | `TEXT UNIQUE` | Flag identifier (e.g. `new-scoring-weights`) |
| `description` | `TEXT` | Human-readable description |
| `default_enabled` | `BOOLEAN` | Default value when no override or rollout applies |
| `rollout_percent` | `INTEGER 0–100` | Global percentage of users who see the flag |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Row update time |

### `feature_flag_overrides`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | Auto-generated |
| `flag_id` | `UUID FK` | References `feature_flags.id` (CASCADE delete) |
| `tenant_id` | `TEXT` | Tenant/organization identifier |
| `enabled` | `BOOLEAN` | Override value — always wins over rollout |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Row update time |

Unique constraint on `(flag_id, tenant_id)`.

### `feature_flag_tenant_rollouts` _(added in migration 020)_

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | Auto-generated |
| `flag_id` | `UUID FK` | References `feature_flags.id` (CASCADE delete) |
| `tenant_id` | `TEXT` | Tenant/organization identifier |
| `rollout_percent` | `INTEGER 0–100` | Per-tenant rollout percentage |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Row update time |

Unique constraint on `(flag_id, tenant_id)`.

## Service API

### `FeatureFlagService`

```typescript
class FeatureFlagService {
  constructor(db?: Queryable, audit?: AuditLogService)

  // Evaluation
  isEnabled(flagKey: string, tenantId: string, userId?: string): Promise<boolean>

  // Reads
  getFlag(flagKey: string): Promise<FeatureFlag | null>
  listFlags(): Promise<FeatureFlag[]>
  listFlagsWithOverrides(tenantId: string): Promise<FeatureFlagWithOverride[]>
  getOverride(flagKey: string, tenantId: string): Promise<FeatureFlagOverride | null>
  getTenantRollout(flagKey: string, tenantId: string): Promise<FeatureFlagTenantRollout | null>

  // Mutations (all write audit logs + outbox events)
  createFlag(key, description, defaultEnabled, rolloutPercent, actor): Promise<FeatureFlag>
  updateFlag(flagKey, updates, actor): Promise<FeatureFlag>
  setOverride(flagKey, tenantId, enabled, actor): Promise<FeatureFlagOverride>
  removeOverride(flagKey, tenantId, actor): Promise<void>
  setTenantRollout(flagKey, tenantId, rolloutPercent, actor): Promise<FeatureFlagTenantRollout>
  removeTenantRollout(flagKey, tenantId, actor): Promise<void>
}
```

### Evaluation order

```
isEnabled(flagKey, tenantId, userId?)
  │
  ├─ 1. feature_flag_overrides[flagKey, tenantId] exists?
  │       YES → return override.enabled
  │
  ├─ 2. feature_flag_tenant_rollouts[flagKey, tenantId] exists?
  │       YES → computeRolloutBucket(tenantRollout.rolloutPercent, userId ?? tenantId, flagKey)
  │
  ├─ 3. flag.rolloutPercent > 0?
  │       YES → computeRolloutBucket(flag.rolloutPercent, userId ?? tenantId, flagKey)
  │
  └─ 4. return flag.defaultEnabled
```

### Sticky bucketing

```typescript
export function computeRolloutBucket(
  rolloutPercent: number,
  entityId: string,  // userId when available, tenantId otherwise
  flagKey: string,   // salt — prevents correlation across flags
): boolean {
  if (rolloutPercent >= 100) return true
  if (rolloutPercent <= 0)   return false
  const hash = createHash('sha256').update(`${flagKey}:${entityId}`).digest('hex')
  const bucket = parseInt(hash.substring(0, 8), 16) % 100
  return bucket < rolloutPercent
}
```

Properties:
- **Deterministic** — same `(flagKey, entityId)` always produces the same bucket, across processes and restarts
- **Stateless** — no per-user records needed; the hash is recomputed on every call
- **Flag-scoped salt** — a user at 25% on `flag-a` may be at 0% on `flag-b`; flags do not correlate
- **Uniform** — the 32-bit hash space distributes evenly over `[0, 100)` for large populations

### `ActorInfo`

```typescript
interface ActorInfo {
  id: string       // Admin/user ID performing the action
  email: string    // Admin/user email
  tenantId: string // Actor's tenant (for audit log tenant context)
  ipAddress?: string
}
```

## Admin API

All routes require Bearer token authentication with admin role. Routes are mounted at `/api/admin/feature-flags`.

### `GET /api/admin/feature-flags`

List all flags with their effective state for the caller's tenant.

Response includes `tenantRollout` (the per-tenant rollout record, or `null`) and `effectiveRolloutPercent` (the percentage actually used for evaluation).

### `POST /api/admin/feature-flags`

Create a new feature flag.

```json
{
  "key": "new-scoring-weights",
  "description": "Enable new scoring algorithm",
  "defaultEnabled": false,
  "rolloutPercent": 0
}
```

### `PUT /api/admin/feature-flags/:key`

Update a feature flag's description, default, or global rollout percent. All fields optional.

```json
{
  "description": "Updated description",
  "defaultEnabled": true,
  "rolloutPercent": 50
}
```

### `POST /api/admin/feature-flags/:key/overrides`

Set a per-tenant **boolean** override (upsert). Takes precedence over everything.

```json
{
  "tenantId": "tenant-abc",
  "enabled": true
}
```

### `DELETE /api/admin/feature-flags/:key/overrides/:tenantId`

Remove a per-tenant boolean override. The tenant then falls back to per-tenant rollout → global rollout → default.

### `POST /api/admin/feature-flags/:key/tenant-rollouts` _(new in #570)_

Set a per-tenant rollout percentage. Allows each tenant to receive the flag at a different rollout speed.

```json
{
  "tenantId": "tenant-abc",
  "rolloutPercent": 25
}
```

Sticky user-id bucketing still applies within the tenant's percentage window. A boolean override (if present) still takes precedence.

### `DELETE /api/admin/feature-flags/:key/tenant-rollouts/:tenantId` _(new in #570)_

Remove a per-tenant rollout percentage. The tenant then falls back to global rollout → default.

## Constants

All magic values (cache key prefixes, TTL, percent bounds, outbox event names) are declared in a single file:

```
src/services/featureFlags/consts.ts
```

Import from there rather than hard-coding values elsewhere.

## Caching

Flags, overrides, and per-tenant rollouts are cached in-memory with a **30-second TTL** (`FLAG_CACHE_TTL_MS`). After any mutation:
- The local in-process cache is invalidated immediately
- A transactional outbox event is emitted for cross-instance cache invalidation

Cache key prefixes:
- Flags: `feature_flag:<key>`
- Boolean overrides: `feature_flag_override:<flagKey>:<tenantId>`
- Per-tenant rollouts: `feature_flag_tenant_rollout:<flagKey>:<tenantId>`
- Full list: `feature_flags:all`

## Audit Logging

All mutations record an audit entry with:
- `action`: `CREATE_FLAG`, `UPDATE_FLAG`, `SET_FLAG_OVERRIDE`, or `REMOVE_FLAG_OVERRIDE`
- `resourceType`: `feature_flag`, `feature_flag_override`, or `feature_flag_tenant_rollout`
- `resourceId`: flag key (or `flagKey:tenantId` for per-tenant records)
- `details`: the mutation input parameters

## Outbox Events

| eventType | Trigger |
|---|---|
| `feature_flag_created` | `createFlag` |
| `feature_flag_updated` | `updateFlag` |
| `feature_flag_override_updated` | `setOverride` |
| `feature_flag_override_removed` | `removeOverride` |
| `feature_flag_tenant_rollout_set` | `setTenantRollout` |
| `feature_flag_tenant_rollout_removed` | `removeTenantRollout` |

All use `aggregateType: 'feature_flag'` and `aggregateId: flagKey`. Outbox write failures are silently swallowed to avoid breaking mutations.

## Edge Cases

- **Unknown flag**: `isEnabled` returns `false`
- **No tenant context**: `tenantId` is required; evaluation uses `tenantId` as the rollout entity when `userId` is absent
- **Boolean override beats per-tenant rollout**: Remove the override first if you want tenant rollout to take effect
- **Rollout rounding**: Percent is treated as an integer 0–100; values outside this range are rejected at the service layer
- **Stale cache**: TTL is 30 s; outbox events enable cross-instance invalidation
- **Outbox write failure**: Silently swallowed so mutations never fail due to outbox errors
