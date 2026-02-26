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

Include the key in one of these headers (Authorization takes precedence):

```http
Authorization: Bearer cr_your_key_here
```

```http
X-API-Key: cr_your_key_here
```

## Scopes

| Scope  | Description                             |
|--------|-----------------------------------------|
| `read` | Read-only access to trust and bond data |
| `full` | Full access, including write operations |

Requests to endpoints that require `full` scope with a `read` key receive **403 Forbidden**.

## Subscription Tiers

| Tier         | Rate limit   |
|--------------|--------------|
| `free`       | 100 req/min  |
| `pro`        | 1 000 req/min |
| `enterprise` | 10 000 req/min |

## Key Lifecycle

### Issue a key

```http
POST /api/keys
Content-Type: application/json

{
  "ownerId": "user_abc",
  "scope": "read",
  "tier": "free"
}
```

Response (201 — the raw key is **only returned here**):

```json
{
  "id": "3f8a1c2b",
  "key": "cr_a3f2b1c0...",
  "prefix": "a3f2b1c0",
  "scope": "read",
  "tier": "free",
  "createdAt": "2026-02-24T12:00:00.000Z"
}
```

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
    "scope": "read",
    "tier": "free",
    "ownerId": "user_abc",
    "createdAt": "2026-02-24T12:00:00.000Z",
    "lastUsedAt": null,
    "active": true
  }
]
```

### Rotate a key

Revokes the current key and issues a new one with the same scope and tier:

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
- Use the `read` scope unless write operations are required.
- Rotate keys periodically; compromised keys can be revoked at any time.
- Rate limits are enforced per tier (integration at the infrastructure layer, e.g. via a reverse proxy or Redis-based limiter).

## Error Responses

| Status | Body                                            | Cause                            |
|--------|-------------------------------------------------|----------------------------------|
| 400    | `{ "error": "ownerId is required" }`            | Missing required field           |
| 401    | `{ "error": "API key required" }`               | No key in request headers        |
| 401    | `{ "error": "Invalid or revoked API key" }`     | Key not found, bad format, or revoked |
| 403    | `{ "error": "Insufficient scope: full access required" }` | `read` key on a `full`-only endpoint |
| 404    | `{ "error": "Key not found" }`                  | Unknown key ID                   |
