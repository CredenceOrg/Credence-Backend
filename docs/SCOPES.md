# API Key Scopes

> **Audience:** Downstream integrators — teams building applications or services on top of the Credence API.

This document explains every scope your API key can carry, which endpoints each scope unlocks, and how to request the exact set of permissions your integration needs.

---

## How scopes work

Every API key is issued with an explicit list of **scopes**. When the key is used on a request, the middleware checks whether the granted scopes satisfy the scope required by that endpoint. The check is **deny-by-default**: if the key does not carry the required scope, the request is rejected with `403 Forbidden` before reaching any handler.

```
POST /api/attestations
Authorization: Bearer cr_a3f2b1c0...
                           │
                    ┌──────▼───────────┐
                    │  requireApiKey   │
                    │  (attestations:  │
                    │   write)         │
                    └──────┬───────────┘
           key has scope?  │
           ┌───────────────┴────────────────┐
           │ yes                            │ no
           ▼                                ▼
    handler runs                 403 Forbidden
                                 { requiredScope,
                                   grantedScopes }
```

The 403 response always includes `requiredScope` and `grantedScopes` so you can diagnose the mismatch without contacting support:

```json
{
  "error": "Forbidden",
  "message": "Insufficient scope: 'attestations:write' is required",
  "requiredScope": "attestations:write",
  "grantedScopes": ["trust:read", "attestations:read"]
}
```

---

## Available scopes

### Granular scopes

Request only the scopes your integration actually uses. Narrower keys reduce blast radius if a credential is compromised.

| Scope                | What it unlocks                                                                    |
|----------------------|------------------------------------------------------------------------------------|
| `trust:read`         | Read trust scores and bond data (`GET /api/trust/*`)                               |
| `attestations:read`  | List and count attestations (`GET /api/attestations/*`)                            |
| `attestations:write` | Create and revoke attestations (`POST /api/attestations`, `DELETE /api/attestations/:id`) |
| `payouts:write`      | Initiate payout / settlement operations (`POST /api/payouts`)                      |
| `reports:generate`   | Trigger and poll report generation jobs (`POST /api/reports`, `GET /api/reports/:jobId`) |
| `exports:read`       | Download report artifacts and audit-log exports (`GET /api/reports/download/:key`) |
| `webhooks:admin`     | Rotate and revoke webhook signing secrets (`POST /api/admin/webhooks/:id/rotate`, `POST /api/admin/webhooks/:id/revoke-previous`) |
| `outbox:reinject`    | Reinsert fixed quarantined outbox events (operator use only)                       |
| `admin:read`         | Read admin resources — users, audit logs, failed events                            |
| `admin:write`        | Mutate admin resources — assign roles, revoke keys, replay events, impersonate     |
| `flags:read`         | Read feature flag state                                                            |
| `flags:write`        | Modify feature flag state                                                          |

### Legacy tier aliases (backward-compatible)

Keys issued before the granular model was introduced carry one of two tier strings. They continue to work and are automatically expanded at validation time — no migration is required.

| Legacy scope  | Automatically expands to                                                                                                                                            |
|---------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `public`      | `trust:read`, `attestations:read`                                                                                                                                   |
| `enterprise`  | All granular scopes (full access)                                                                                                                                   |

Do **not** request `enterprise` for new integrations unless every operation listed above is genuinely needed. Issue per-operation keys instead.

---

## Endpoint → scope mapping

| Endpoint                                        | Required scope          |
|-------------------------------------------------|-------------------------|
| `GET /api/trust/:address`                       | `trust:read`            |
| `GET /api/attestations/:identity`               | `attestations:read`     |
| `GET /api/attestations/:identity/count`         | `attestations:read`     |
| `POST /api/attestations`                        | `attestations:write`    |
| `DELETE /api/attestations/:id`                  | `attestations:write`    |
| `POST /api/payouts`                             | `payouts:write`         |
| `POST /api/reports`                             | `reports:generate`      |
| `GET /api/reports/:jobId`                       | `reports:generate`      |
| `GET /api/reports/download/:key`                | *(signed URL — no key)* |
| `POST /api/admin/webhooks/:id/rotate`           | `webhooks:admin`        |
| `POST /api/admin/webhooks/:id/revoke-previous`  | `webhooks:admin`        |

---

## Requesting scopes when issuing a key

Pass an explicit `scopes` array when creating a key. The raw key is returned exactly once in the 201 response — store it securely.

```http
POST /api/api-keys
Content-Type: application/json
Authorization: Bearer cr_<your_key_here>

{
  "ownerId": "service-account-payments",
  "scopes": ["attestations:read", "attestations:write"],
  "tier": "pro"
}
```

Response:

```json
{
  "id": "3f8a1c2b",
  "key": "cr_a3f2b1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1",
  "prefix": "a3f2b1c0",
  "scopes": ["attestations:read", "attestations:write"],
  "tier": "pro",
  "createdAt": "2026-07-29T14:00:00.000Z"
}
```

> The raw key value is shown **only once**. After this response, only a SHA-256 hash is stored. If you lose the key, rotate it to get a new one.

---

## Sending the key on requests

Include the key in one of these headers (`X-API-Key` takes precedence when both are present):

```http
X-API-Key: cr_a3f2b1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
```

```http
Authorization: Bearer cr_a3f2b1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
```

### Minimal working example

```bash
# Issue a key with trust:read scope
KEY_RESPONSE=$(curl -s -X POST https://api.example.com/api/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer cr_<admin_key>" \
  -d '{"ownerId":"my-service","scopes":["trust:read"],"tier":"free"}')

API_KEY=$(echo "$KEY_RESPONSE" | jq -r '.key')

# Use the key
curl -s https://api.example.com/api/trust/GABCDE... \
  -H "X-API-Key: $API_KEY"
```

---

## Choosing the right scopes

A few guidelines for new integrations:

1. **Read-only dashboards / monitoring** — `trust:read`, `attestations:read`
2. **Attestation pipelines** — `attestations:read`, `attestations:write`
3. **Settlement / payout automation** — `payouts:write` (add `attestations:write` only if the same service also writes attestations)
4. **Report generation services** — `reports:generate`, `exports:read`
5. **Webhook rotation scripts** — `webhooks:admin` only
6. **Full-access service accounts** — prefer combining granular scopes over using `enterprise`

---

## Key lifecycle

| Operation  | How                                     | Effect                                                   |
|------------|-----------------------------------------|----------------------------------------------------------|
| Issue      | `POST /api/api-keys`                    | Creates a new key; raw value returned once               |
| List       | `GET /api/api-keys/:ownerId`            | Returns metadata (no raw key)                            |
| Rotate     | `POST /api/api-keys/:id/rotate`         | Revokes old key, issues new key with the same scopes     |
| Revoke     | `DELETE /api/api-keys/:id`              | Immediately invalidates key; subsequent requests get 401 |

Revocation is immediate. A revoked key cannot be reactivated — issue a new one if access needs to be restored.

---

## Error reference

| Status | Cause                                          | Body (example)                                                                                                    |
|--------|------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| 401    | No key in request headers                      | `{"error":"Unauthorized","message":"API key is required"}`                                                        |
| 401    | Key not found, bad format, or revoked          | `{"error":"Unauthorized","message":"Invalid API key"}`                                                            |
| 403    | Key lacks the required scope                   | `{"error":"Forbidden","message":"Insufficient scope: 'attestations:write' is required","requiredScope":"attestations:write","grantedScopes":["trust:read"]}` |

---

## See also

- **[docs/api-keys.md](api-keys.md)** — Full API key CRUD reference with request/response examples, rotation, and revocation.
- **[docs/SECURITY.md](SECURITY.md)** — Security architecture: deny-by-default enforcement, no scope escalation on rotation, audit trail on every 403.
- **[docs/JWT_CLAIMS.md](JWT_CLAIMS.md)** — The `scope` claim in JWTs and how consumer middleware validates it.
- **[docs/rate-limiting.md](rate-limiting.md)** — Per-tier rate limits (`free` 100 req/min · `pro` 1 000 req/min · `enterprise` 10 000 req/min).
