# API Key Authentication

Credence API supports API key authentication for programmatic access.

## Key Format

All keys follow this format:

```
cr_<64 lowercase hex characters>
```

Total length: **67 characters**. Example:

```
cr_a3f2b1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
```

## Sending a Key

Include the key in one of these headers (`X-API-Key` takes precedence):

```http
X-API-Key: cr_your_key_here
```

```http
Authorization: Bearer cr_your_key_here
```

## Granular Scopes

Each API key is issued with one or more **scopes** that control exactly which endpoints it may call. This enforces least-privilege: a key can only do what it was explicitly granted.

| Scope                | Description                                                        |
|----------------------|--------------------------------------------------------------------|
| `trust:read`         | Read-only access to trust scores and bond data                     |
| `attestations:read`  | List and count attestations                                        |
| `attestations:write` | Create or revoke attestations                                      |
| `payouts:write`      | Initiate payout / settlement operations                            |
| `reports:generate`   | Trigger and poll report generation jobs                            |
| `exports:read`       | Download report artifacts and audit-log exports                    |
| `webhooks:admin`     | Manage webhook signing secrets (rotate / revoke)                   |
| `admin:read`         | Read admin resources (users, audit logs, failed events)            |
| `admin:write`        | Mutate admin resources (assign roles, revoke keys, replay events, impersonate) |

### Legacy tier aliases (backward-compatible)

Keys issued before the granular scope model was introduced carry one of two legacy values. They continue to work and are automatically expanded:

| Legacy scope  | Expands to                                                                                                                                      |
|---------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| `public`      | `trust:read`, `attestations:read`                                                                                                               |
| `enterprise`  | All granular scopes (full access)                                                                                                               |

### Scope enforcement per endpoint

| Endpoint                                    | Required scope          |
|---------------------------------------------|-------------------------|
| `GET /api/trust/*`                          | `trust:read`            |
| `GET /api/attestations/:identity`           | `attestations:read`     |
| `GET /api/attestations/:identity/count`     | `attestations:read`     |
| `POST /api/attestations`                    | `attestations:write`    |
| `DELETE /api/attestations/:id`              | `attestations:write`    |
| `POST /api/payouts`                         | `payouts:write`         |
| `POST /api/reports`                         | `reports:generate`      |
| `GET /api/reports/:jobId`                   | `reports:generate`      |
| `GET /api/reports/download/:key`            | *(signed URL — no key)* |
| `POST /api/admin/webhooks/:id/rotate`       | `webhooks:admin` *(or admin role)* |
| `POST /api/admin/webhooks/:id/revoke-previous` | `webhooks:admin` *(or admin role)* |
| `GET /api/admin/users`                      | admin role              |
| `GET /api/admin/audit-logs`                 | admin role              |
| `GET /api/admin/audit-logs/export`          | admin role              |
| `POST /api/admin/roles/assign`              | admin role              |
| `POST /api/admin/keys/revoke`               | admin role              |
| `POST /api/admin/impersonate`               | admin role              |
| `POST /api/admin/events/replay/:id`         | admin role              |

## Subscription Tiers

| Tier         | Rate limit     |
|--------------|----------------|
| `free`       | 100 req/min    |
| `pro`        | 1 000 req/min  |
| `enterprise` | 10 000 req/min |

## Key Lifecycle

### Issue a key

```http
POST /api/keys
Content-Type: application/json

{
  "ownerId": "user_abc",
  "scopes": ["trust:read", "attestations:read"],
  "tier": "free"
}
```

Response (201 — the raw key is **only returned here**):

```json
{
  "id": "3f8a1c2b",
  "key": "cr_a3f2b1c0...",
  "prefix": "a3f2b1c0",
  "scopes": ["trust:read", "attestations:read"],
  "scope": "trust:read",
  "tier": "free",
  "createdAt": "2026-02-24T12:00:00.000Z"
}
```

> `scope` (singular) is kept for backward compatibility and reflects the first granted scope.

### List keys for an owner

```http
GET /api/keys?ownerId=user_abc
```

Response omits the raw key and the stored hash:

```json
[
  {
    "id": "3f8a1c2b",
    "prefix": "a3f2b1c0",
    "scopes": ["trust:read", "attestations:read"],
    "scope": "trust:read",
    "tier": "free",
    "ownerId": "user_abc",
    "createdAt": "2026-02-24T12:00:00.000Z",
    "lastUsedAt": null,
    "active": true
  }
]
```

### Rotate a key

Revokes the current key and issues a new one with the same scopes and tier:

```http
POST /api/keys/:id/rotate
```

Response: same shape as key creation (201), including the new raw key.

### Revoke a key

```http
DELETE /api/keys/:id
```

Response: **204 No Content**. Subsequent requests using the revoked key receive **401 Unauthorized**.

## Security Notes

- Keys are stored as **SHA-256 hashes** — the raw key is never persisted and is shown exactly once.
- Issue keys with the **minimum scopes required** for the integration. Do not use `enterprise` unless all operations are needed.
- Rotate keys periodically; compromised keys can be revoked at any time.
- Rate limits are enforced per tier (integration at the infrastructure layer, e.g. via a reverse proxy or Redis-based limiter).
- The middleware is **deny-by-default**: if a key does not carry the required scope, the request is rejected with `403 Forbidden` before reaching the handler.

- **Timing-safe validation**: Keys are validated by hashing the presented key and performing constant-time checks against stored hashes to mitigate timing attacks. Implementations must avoid early-exit string comparisons on raw keys.
- **No logging of raw keys**: Never log or persist raw API key values in application logs, error messages, or monitoring systems.

## Error Responses

| Status | Body                                                                 | Cause                                          |
|--------|----------------------------------------------------------------------|------------------------------------------------|
| 400    | `{ "error": "ownerId is required" }`                                 | Missing required field                         |
| 401    | `{ "error": "Unauthorized", "message": "API key is required" }`      | No key in request headers                      |
| 401    | `{ "error": "Unauthorized", "message": "Invalid API key" }`          | Key not found, bad format, or revoked          |
| 403    | `{ "error": "Forbidden", "message": "Insufficient scope: '...' is required", "requiredScope": "...", "grantedScopes": [...] }` | Key lacks the required scope |
| 404    | `{ "error": "Key not found" }`                                       | Unknown key ID                                 |
