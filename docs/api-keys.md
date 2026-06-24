# API Key Authentication

Credence API supports API key authentication for programmatic access with fine-grained scope-based access control.

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

Include the key in one of these headers (Authorization takes precedence):

```http
Authorization: Bearer cr_your_key_here
```

```http
X-API-Key: cr_your_key_here
```

## Scopes

API keys use a least-privilege model with fine-grained scopes. Each key can have multiple scopes, or none (minimum access).

| Scope              | Description                              |
|--------------------|------------------------------------------|
| `bond:read`        | Read bond information                    |
| `bond:write`       | Write/modify bond information            |
| `attestation:write`| Create attestations                      |
| `trust:read`       | Read trust/reputation scores             |
| `payouts:write`    | Write/modify payout information          |

### Scope Enforcement

- **Default behavior**: New keys are created with an empty scope array (least privilege)
- **Multiple scopes**: A single key can have multiple scopes for combined access
- **403 Forbidden**: Requests to endpoints requiring a scope not present on the key receive 403
- **Security**: The error response does not reveal which specific scope is missing

## Subscription Tiers

| Tier         | Rate limit   |
|--------------|--------------|
| `free`       | 100 req/min  |
| `pro`        | 1 000 req/min |
| `enterprise` | 10 000 req/min |

## Key Lifecycle

### Issue a key

```http
POST /api/api-keys
Content-Type: application/json
Authorization: Bearer <key_with_bond:write_scope>

{
  "ownerId": "user_abc",
  "scopes": ["bond:read", "trust:read"],
  "tier": "free"
}
```

Response (201 — the raw key is **only returned here**):

```json
{
  "id": "3f8a1c2b",
  "key": "cr_a3f2b1c0...",
  "prefix": "a3f2b1c0",
  "scopes": ["bond:read", "trust:read"],
  "tier": "free",
  "createdAt": "2026-02-24T12:00:00.000Z"
}
```

### List keys for an owner

```http
GET /api/api-keys/:ownerId
Authorization: Bearer <valid_api_key>
```

Response omits the raw key and the stored hash:

```json
[
  {
    "id": "3f8a1c2b",
    "prefix": "a3f2b1c0",
    "scopes": ["bond:read", "trust:read"],
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
POST /api/api-keys/:id/rotate
Authorization: Bearer <valid_api_key>
```

Response: same shape as key creation (201), including the new raw key.

### Revoke a key

```http
DELETE /api/api-keys/:id
Authorization: Bearer <valid_api_key>
```

Response: **204 No Content**. Subsequent requests using the revoked key receive **401 Unauthorized**.

## Security Notes

- Keys are stored as **SHA-256 hashes** — the raw key is never persisted and is shown exactly once.
- **Least privilege**: Create keys with only the scopes needed for their intended use.
- **Scope isolation**: A leaked key with limited scopes (e.g., `trust:read`) is contained vs. a full-access key.
- Rotate keys periodically; compromised keys can be revoked at any time.
- All key operations (create, revoke, rotate) are logged to the audit log.
- Rate limits are enforced per tier (integration at the infrastructure layer, e.g. via a reverse proxy or Redis-based limiter).

## Error Responses

| Status | Body                                            | Cause                            |
|--------|-------------------------------------------------|----------------------------------|
| 400    | `{ "error": "ownerId is required" }`            | Missing required field           |
| 400    | `{ "error": "Invalid scopes: ..." }`           | Invalid scope values provided    |
| 401    | `{ "error": "API key required" }`               | No key in request headers        |
| 401    | `{ "error": "Invalid or revoked API key" }`     | Key not found, bad format, or revoked |
| 403    | `{ "error": "Insufficient scope" }`             | Key lacks required scope for endpoint |
| 404    | `{ "error": "API key not found" }`             | Unknown key ID                   |

## Middleware Usage

### requireApiKey

Validates the API key and attaches the key record to `req.apiKeyRecord`:

```typescript
import { requireApiKey } from '../middleware/apiKey.js'

router.get('/data', requireApiKey(), handler)
```

### requireScope

Checks if the validated API key has the required scope. Must be used after `requireApiKey`:

```typescript
import { requireApiKey, requireScope } from '../middleware/apiKey.js'
import { ApiKeyScope } from '../services/apiKeys.js'

router.get('/bonds', requireApiKey(), requireScope(ApiKeyScope.BOND_READ), handler)
router.post('/attestations', requireApiKey(), requireScope(ApiKeyScope.ATTESTATION_WRITE), handler)
```
