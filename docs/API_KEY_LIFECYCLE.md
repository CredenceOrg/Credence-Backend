# Integration API Key Lifecycle

**Target audience:** Contributors and operators who need to understand the complete
integration API key lifecycle — creation, listing, rotation, and revocation.

The Credence Backend provides a programmatic API for managing integration API keys.
Every mutating operation is recorded in the audit trail and every response is
subject to ownership and authorization checks.

---

## 1. Key Format

All keys follow the format:

```
cr_<64 lowercase hex characters>
```

Total length: **67 characters**. Example:

```
cr_a3f2b1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
```

The first 8 hex characters after the `cr_` prefix serve as a **lookup prefix**
for fast database index scans without full-hash comparisons on every request.

---

## 2. Storage & Security

- Raw keys are **never persisted**. Only the **SHA-256 hash** is stored in the
  `api_keys` table (`hashed_key` column, `varchar(64)`, unique).
- The raw key is returned **exactly once**: in the response body of a successful
  `POST` (create) or `POST .../rotate` (rotate) call. After that the service
  cannot recover it.
- Validation uses constant-time hash comparison to mitigate timing attacks.
- The `api_keys` table includes a composite index on `(owner_id, active)` for
  efficient per-owner queries.

See `src/migrations/006_add_api_keys_table.ts` for the full schema.

---

## 3. API Endpoints

All endpoints are mounted at `/api/integrations/keys` and require **user
authentication** via JWT (`requireUserAuth` middleware). API-key-based auth is
not accepted for key management operations.

| Method   | Path                                 | Description                          |
|----------|--------------------------------------|--------------------------------------|
| `POST`   | `/api/integrations/keys`             | Issue a new integration API key      |
| `GET`    | `/api/integrations/keys`             | List keys for the authenticated user |
| `POST`   | `/api/integrations/keys/:id/rotate`  | Rotate a key (safe invalidation)     |
| `DELETE` | `/api/integrations/keys/:id`         | Permanently revoke a key             |

### 3.1 Create — `POST /api/integrations/keys`

Issue a new API key with an optional scope and tier.

**Request:**

```http
POST /api/integrations/keys
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "scope": "read",
  "tier": "free"
}
```

| Field   | Type   | Default  | Description                                                  |
|---------|--------|----------|--------------------------------------------------------------|
| `scope` | string | `"read"` | Access scope — `"read"` or `"full"`.                         |
| `tier`  | string | `"free"` | Subscription tier controlling rate limits — `"free"`, `"pro"`, or `"enterprise"`. |

**Success response (201):**

```json
{
  "success": true,
  "data": {
    "id": "a1b2c3d4",
    "key": "cr_a3f2b1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1",
    "prefix": "a3f2b1c0",
    "scope": "read",
    "scopes": ["read"],
    "tier": "free",
    "createdAt": "2026-07-29T12:00:00.000Z"
  }
}
```

> **Store the `key` value securely.** It is the last time the raw key will be visible.

**Validation errors (400):**

```json
{ "error": "Invalid scope. Allowed values: read, full" }
```
```json
{ "error": "Invalid tier. Allowed values: free, pro, enterprise" }
```

### 3.2 List — `GET /api/integrations/keys`

Return all keys belonging to the authenticated user. The raw key and its hash
are **never** included in the response.

**Request:**

```http
GET /api/integrations/keys
Authorization: Bearer <jwt_token>
```

**Success response (200):**

```json
{
  "success": true,
  "data": [
    {
      "id": "a1b2c3d4",
      "prefix": "a3f2b1c0",
      "scope": "read",
      "scopes": ["read"],
      "tier": "free",
      "ownerId": "user_abc",
      "createdAt": "2026-07-29T12:00:00.000Z",
      "lastUsedAt": null,
      "active": true
    },
    {
      "id": "e5f6a7b8",
      "prefix": "c9d0e1f2",
      "scope": "full",
      "scopes": ["full"],
      "tier": "pro",
      "ownerId": "user_abc",
      "createdAt": "2026-07-28T10:00:00.000Z",
      "lastUsedAt": "2026-07-29T11:30:00.000Z",
      "active": false
    }
  ]
}
```

Keys are returned in **descending order** by `createdAt`. Both active and
revoked keys are listed so operators can audit historical key assignments.

### 3.3 Rotate — `POST /api/integrations/keys/:id/rotate`

Atomically revoke the existing key and issue a replacement that inherits the
same owner, scope, and tier. This is the canonical "safe invalidation" path.

**Request:**

```http
POST /api/integrations/keys/a1b2c3d4/rotate
Authorization: Bearer <jwt_token>
```

**Success response (200):**

```json
{
  "success": true,
  "message": "API key rotated. Store the new key securely — it will not be shown again.",
  "data": {
    "id": "f9e8d7c6",
    "key": "cr_b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5",
    "prefix": "b4c5d6e7",
    "scope": "read",
    "scopes": ["read"],
    "tier": "free",
    "createdAt": "2026-07-29T12:05:00.000Z"
  }
}
```

**Error responses:**

| Status | Condition                  | Body                                                     |
|--------|----------------------------|----------------------------------------------------------|
| 404    | Key ID not found           | `{ "error": "API key", "message": "API key 'bad-id' not found" }` |
| 409    | Key already revoked        | `{ "error": "Conflict", "message": "API key is already revoked and cannot be rotated" }` |
| 403    | Non-owner, non-admin caller | `{ "error": "Forbidden", "message": "You do not have permission to rotate this API key" }` |

**Ownership rules:**
- A user can rotate their own keys.
- Admin and super-admin users can rotate any key.
- Non-admin, non-owner callers receive `403 Forbidden`.

### 3.4 Revoke — `DELETE /api/integrations/keys/:id`

Permanently deactivate an API key. Subsequent requests using the revoked key
receive `401 Unauthorized`.

**Request:**

```http
DELETE /api/integrations/keys/a1b2c3d4
Authorization: Bearer <jwt_token>
```

**Success response (200):**

```json
{
  "success": true,
  "message": "API key revoked successfully"
}
```

**Error responses:**

| Status | Condition                  | Body                                                                |
|--------|----------------------------|---------------------------------------------------------------------|
| 404    | Key ID not found           | `{ "error": "API key", "message": "API key 'bad-id' not found" }`  |
| 403    | Non-owner, non-admin caller | `{ "error": "Forbidden", "message": "You do not have permission to revoke this API key" }` |

The same ownership rules as rotation apply.

---

## 4. Audit Trail

Every lifecycle operation is written to the chain-backed audit log:

| Operation | Audit action               | Status `"success"` includes      | Status `"failure"` includes            |
|-----------|----------------------------|-----------------------------------|----------------------------------------|
| Create    | `CREATE_API_KEY`           | key ID, prefix, scope, tier       | — (creation cannot fail at service layer) |
| Rotate    | `ROTATE_API_KEY`           | revoked key ID, new key ID, new key prefix, scope, tier, owner ID | `reason`: `"key_not_found"` or `"key_already_revoked"` |
| Revoke    | `REVOKE_API_KEY`           | key ID, owner ID, prefix          | — (failure logged with `"API key not found"`) |

All entries include:

| Field        | Description                                      |
|--------------|--------------------------------------------------|
| `tenantId`   | Resolved from the ambient request context (ALS). |
| `actorId`    | The authenticated user's ID.                     |
| `actorEmail` | The authenticated user's email.                  |
| `resourceId` | The API key's opaque ID.                         |
| `resourceType` | Always `"api_key"`.                            |
| `ipAddress`  | The originating IP, when available.              |

See `src/services/apiKeyRotationService.ts` for the implementation of every
audit record.

---

## 5. Authorization Model

| Operation | Authenticated as     | Authorization check                           |
|-----------|----------------------|-----------------------------------------------|
| Create    | Any authenticated user | No additional check (user creates for self) |
| List      | Any authenticated user | Scoped to caller's `ownerId`                 |
| Rotate    | Owner or admin       | Owner match or admin/super-admin role          |
| Revoke    | Owner or admin       | Owner match or admin/super-admin role          |

Authentication is enforced by the `requireUserAuth` middleware (JWT bearer
token). API keys themselves cannot manage other API keys — this prevents a
compromised integration key from escalating privileges.

---

## 6. Scopes & Tiers

### Scopes

| Scope   | Description                                                                 |
|---------|-----------------------------------------------------------------------------|
| `read`  | Read-only access to the integration's permitted resources.                  |
| `full`  | Full read/write access within the integration's permitted resource scope.    |

Scope validation is strict: any value other than `"read"` or `"full"` is
rejected with a `400` error.

### Tiers

| Tier        | Rate limit (requests/min) | Intended use case            |
|-------------|---------------------------|------------------------------|
| `free`      | 100                       | Development / low-volume     |
| `pro`       | 1 000                     | Production / moderate-volume |
| `enterprise`| 10 000                    | High-volume / dedicated      |

See `docs/RATE_LIMITING_DESIGN.md` for burst allowances and reset windows.

---

## 7. Implementation Architecture

```
┌──────────────┐     HTTP     ┌───────────────────┐
│   Client     │ ──────────▶  │  createApiKeyRouter│
│ (JWT-auth)   │ ◀──────────  │   (routes/apiKeys) │
└──────────────┘              └────────┬──────────┘
                                       │
                          ┌────────────┴────────────┐
                          │  ApiKeyRotationService   │
                          │  (business logic + audit)│
                          └────────┬────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │        ApiKeyRepository      │
                    │   (InMemoryApiKeyRepository  │
                    │     or future DB adapter)    │
                    └──────────────┬──────────────┘
                                   │
                          ┌───────┴───────┐
                          │   apiKeys.ts  │
                          │ (key gen,     │
                          │  hash, store) │
                          └───────────────┘
```

- **`src/routes/apiKeys.ts`** — Express router with four endpoints.
- **`src/services/apiKeyRotationService.ts`** — Business logic with audit logging.
- **`src/repositories/apiKeyRepository.ts`** — `ApiKeyRepository` interface and
  `InMemoryApiKeyRepository` implementation.
- **`src/services/apiKeys.ts`** — Low-level key generation, hashing, and
  in-memory store functions.
- **`src/middleware/auth.ts`** — `requireUserAuth` JWT middleware.
- **`src/db/repositories/apiKeysRepository.ts`** — PostgreSQL-backed repository
  (ready for DB wiring).

---

## 8. Security Properties

1. **Hash-only storage:** Raw keys are SHA-256 hashed before storage. The raw
   value exists only in the HTTP response and the caller's secure store.
2. **Constant-time comparison:** Validation uses the full SHA-256 hash, not
   string prefix matching, to prevent timing side channels.
3. **No key-for-key management:** You cannot use an API key to manage other API
   keys. Only JWT-authenticated sessions may create, list, rotate, or revoke
   keys.
4. **Audit trail:** Every mutation is logged with the actor, resource, and
   outcome. Rotation failures (not found, already revoked) are also recorded so
   suspicious probes are visible.
5. **Ownership scoping:** By default a user can only act on their own keys.
   Admins may act on any key — this is audited through the same mechanism.

---

## 9. Configuration

No environment variables are required specifically for the API key lifecycle.
The feature is self-contained and uses defaults throughout.

| Variable (if wired)     | Default | Purpose                       |
|-------------------------|---------|-------------------------------|
| `DATABASE_URL`          | —       | When set, enables DB-backed key repository (future) |

---

## 10. Related Documents

| Document | Covers |
|---|---|
| `docs/api-keys.md` | API key format, granular scopes, subscription tiers, error response reference |
| `docs/SECRETS.md` | Secret types, rotation cadence, and blast radius for all credential types |
| `docs/SECURITY.md` | Security architecture overview |
| `docs/JWT_CLAIMS.md` | JWT claims, headers, and consumer middleware |
| `docs/RATE_LIMITING_DESIGN.md` | Rate limit tiers, burst allowances, reset windows |
| `src/routes/apiKeys.ts` | Route handler implementation |
| `src/services/apiKeyRotationService.ts` | Audit-logged rotation service implementation |
| `tests/routes/apiKeys.test.ts` | Route-level test suite (all four operations, auth guards, audit verification) |
