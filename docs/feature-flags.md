# Feature Flags

## Overview

The feature flag service provides per-tenant toggles for code paths that should be rolled out gradually across organizations. It supports three evaluation layers (in priority order):

1. **Per-tenant override** — explicitly enables or disables a flag for a specific tenant
2. **Rollout percent** — deterministic percentage-based rollout using a SHA-256 hash of `flagKey + userId` (or `tenantId` if no user context)
3. **Default enabled** — fallback when neither override nor rollout is configured

Every mutation (create, update, set override, remove override) writes an audit log entry and emits a transactional outbox event for cache invalidation.

## Tables

### `feature_flags`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | Auto-generated |
| `key` | `TEXT UNIQUE` | Flag identifier (e.g. `new-scoring-weights`) |
| `description` | `TEXT` | Human-readable description |
| `default_enabled` | `BOOLEAN` | Default value when no override or rollout applies |
| `rollout_percent` | `INTEGER` | 0–100, percentage of users who see the flag |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Row update time |

### `feature_flag_overrides`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | Auto-generated |
| `flag_id` | `UUID FK` | References `feature_flags.id` (CASCADE delete) |
| `tenant_id` | `TEXT` | Tenant/organization identifier |
| `enabled` | `BOOLEAN` | Override value for this tenant |
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

  // Mutations (all write audit logs + outbox events)
  createFlag(key: string, description: string, defaultEnabled: boolean, rolloutPercent: number, actor: ActorInfo): Promise<FeatureFlag>
  updateFlag(flagKey: string, updates: UpdateFlagInput, actor: ActorInfo): Promise<FeatureFlag>
  setOverride(flagKey: string, tenantId: string, enabled: boolean, actor: ActorInfo): Promise<FeatureFlagOverride>
  removeOverride(flagKey: string, tenantId: string, actor: ActorInfo): Promise<void>
}
```

### Evaluation order

1. If a per-tenant override exists for the given `flagKey + tenantId` → return override value
2. If `rolloutPercent > 0` → compute `SHA-256(flagKey + ":" + entityId)`, take the first 8 hex chars as a number modulo 100, compare to `rolloutPercent`; `entityId` is `userId ?? tenantId`
3. Return `defaultEnabled`

### ActorInfo

```typescript
interface ActorInfo {
  id: string       // Admin/user ID performing the action
  email: string    // Admin/user email
  tenantId: string // Actor's tenant (for audit log tenant context)
  ipAddress?: string
}
```

## Admin API

All routes require user authentication with admin role. Routes are mounted at `/api/admin/feature-flags`.

### `GET /api/admin/feature-flags`

List all flags with their effective state for the caller's tenant.

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "key": "new-scoring-weights",
      "description": "Enable new scoring algorithm",
      "defaultEnabled": false,
      "rolloutPercent": 25,
      "createdAt": "...",
      "updatedAt": "...",
      "override": { "id": "...", "tenantId": "tenant-1", "enabled": true, ... },
      "effectiveEnabled": true
    }
  ]
}
```

### `POST /api/admin/feature-flags`

Create a new feature flag.

Body:
```json
{
  "key": "new-scoring-weights",
  "description": "Enable new scoring algorithm",
  "defaultEnabled": false,
  "rolloutPercent": 0
}
```

### `PUT /api/admin/feature-flags/:key`

Update a feature flag's description, default, or rollout percent.

Body (all fields optional):
```json
{
  "description": "Updated description",
  "defaultEnabled": true,
  "rolloutPercent": 50
}
```

### `POST /api/admin/feature-flags/:key/overrides`

Set a per-tenant override (upsert semantics).

Body:
```json
{
  "tenantId": "tenant-abc",
  "enabled": true
}
```

### `DELETE /api/admin/feature-flags/:key/overrides/:tenantId`

Remove a per-tenant override.

## Caching

Flags and overrides are cached in-memory with a 30-second TTL. After any mutation:
- The local cache is invalidated immediately
- A transactional outbox event is emitted for cross-process cache invalidation

Outbox events use:
- `aggregateType: 'feature_flag'`
- `aggregateId`: flag key
- `eventType`: one of `feature_flag_created`, `feature_flag_updated`, `feature_flag_override_updated`, `feature_flag_override_removed`

## Audit Logging

All mutations record an audit log entry with:
- `action`: `CREATE_FLAG`, `UPDATE_FLAG`, `SET_FLAG_OVERRIDE`, or `REMOVE_FLAG_OVERRIDE`
- `resourceType`: `feature_flag` or `feature_flag_override`
- `resourceId`: flag key (or `flagKey:tenantId` for overrides)
- `details`: the mutation input parameters
- `actorId` / `actorEmail`: from the authenticated user

## Rollout Distribution

Rollout percent uses deterministic hashing so the same user always gets the same result:

```typescript
const hash = createHash('sha256').update(`${flagKey}:${entityId}`).digest('hex')
const bucket = Number.parseInt(hash.substring(0, 8), 16) % 100
return bucket < rolloutPercent
```

This ensures:
- A user at 25% rollout will stay at 25% as rollout increases
- The distribution across users is statistically uniform
- No sticky state needs to be stored per user

## Edge Cases

- **Unknown flag**: `isEnabled` returns `false`
- **No tenant context**: `tenantId` is required for all operations; evaluation uses `tenantId` as the rollout entity when `userId` is absent
- **Stale cache**: Cache TTL is 30 seconds; outbox events enable cross-instance invalidation
- **Rollout rounding**: Percent is treated as an integer 0–100; values outside this range are rejected at the service layer
- **Outbox write failure**: Outbox errors are silently swallowed to avoid breaking the primary mutation
