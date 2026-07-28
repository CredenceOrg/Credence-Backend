# Retry Semantics

**Audience:** Downstream integrators (API clients, SDK consumers, webhook subscribers) retrying requests after transient failures.

This document tells you which Credence Backend API endpoints can be safely retried and under what conditions. Using the wrong retry strategy can cause duplicate side effects — duplicate payouts, double attestations, or orphaned records.

---

## The short answer

| HTTP method | Safe to retry? | Condition |
|-------------|----------------|-----------|
| `GET` | Yes | Always |
| `PUT` | Yes | Always |
| `DELETE` | Yes | Always |
| `POST` | Yes | If you send an `Idempotency-Key` header |
| `POST` | No | If you do **not** send an `Idempotency-Key` header |

The key difference is the `Idempotency-Key` header. Every `/api` route supports it, but only the endpoints listed below are **safe to retry without one** because they are inherently idempotent or read-only.

---

## Endpoints safe to retry without an idempotency key

These endpoints are safe because they never create or mutate state on repeated calls (or the server guarantees the same result).

### Health checks

```
GET /api/health
```

Returns `{"status":"ok","service":"credence-backend"}`. Safe to poll aggressively during incidents.

### Trust score lookups

```
GET /api/trust/:address
```

Returns a trust score for a Stellar address. Retrying is safe — the score is a computed snapshot with no side effects.

**Example response:**

```json
{
  "address": "GAIQ...XPQ",
  "score": 87,
  "trustLevel": "high",
  "lastUpdated": "2026-07-28T12:00:00Z"
}
```

### Bond status lookups

```
GET /api/bond/:address
```

Returns bond status for a Stellar address. Read-only; safe to retry.

### Attestation listings

```
GET /api/attestations/:address
```

Returns a list of attestations for an address. Read-only; safe to retry.

### Verification proofs

```
GET /api/verification/:address
```

Returns a verification proof (stub endpoint). Read-only; safe to retry.

### Analytics summaries

```
GET /api/analytics/summary
```

Returns aggregated analytics. Read-only; safe to retry.

### Reports

```
GET /api/reports/top-talkers
```

Returns the top N tenants by request count. Read-only; safe to retry.

### Pagination-based list endpoints

All list endpoints that support `offset/page` or cursor pagination are safe to retry. Re-sending the same pagination request returns the same page of results as long as the underlying data does not change.

---

## Endpoints safe to retry WITH an idempotency key

Send an `Idempotency-Key` header (unique value per logical request) to make repeated POST requests safe. If the same key is sent again, the server replays the cached response instead of re-executing the handler.

### Create attestation

```
POST /api/attestations
```

**Risk of retrying without a key:** Duplicate attestations created for the same subject.

**Safe retry (with key):**

```bash
curl -X POST https://api.credence.io/api/attestations \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: attestation-2026-07-28-abc123" \
  -d '{
    "subject": "GAIQ...XPQ",
    "attestor": "GXYZ...ABC",
    "claim": "KYC verified",
    "evidence": "document-hash-0xabc"
  }'
```

**Response on first call (201):**

```json
{
  "id": "att_01HXYZ...",
  "subject": "GAIQ...XPQ",
  "attestor": "GXYZ...ABC",
  "claim": "KYC verified",
  "status": "active",
  "createdAt": "2026-07-28T12:00:00Z"
}
```

**Response on retry with same key (201, same body):**

```json
{
  "id": "att_01HXYZ...",
  "subject": "GAIQ...XPQ",
  "attestor": "GXYZ...ABC",
  "claim": "KYC verified",
  "status": "active",
  "createdAt": "2026-07-28T12:00:00Z"
}
```

### Create attestation batch (bulk)

```
POST /api/bulk/attestations
```

Same idempotency behavior as single attestation creation. Retrying with the same key returns the original batch result.

### Admin: assign role to user

```
POST /api/admin/orgs/:orgId/roles/assign
```

Protected by both the global idempotency middleware and the explicit per-route idempotency guard.

**Risk of retrying without a key:** User could be assigned the same role twice (logged as duplicate, but the role assignment is idempotent so no harm).

**Safe retry (with key):**

```bash
curl -X POST https://api.credence.io/api/admin/orgs/org_123/roles/assign \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: assign-role-org123-user456-admin" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "userId": "user_456",
    "role": "admin"
  }'
```

### Admin: revoke API key

```
POST /api/admin/keys/revoke
```

Protected by per-route idempotency guard.

**Risk of retrying without a key:** The key is revoked once; subsequent identical requests return the same 200 response (the key is already gone, so the second revocation is a no-op).

### Admin: issue impersonation token

```
POST /api/admin/impersonate
```

Protected by per-route idempotency guard.

**Risk of retrying without a key:** A new impersonation token is issued for each attempt. With an idempotency key, the same token is returned on retry.

### Create payout

```
POST /api/payouts
```

Protected by per-route idempotency guard. This is a high-risk endpoint — retrying without a key can cause duplicate payouts.

**Risk of retrying without a key:** Duplicate payout created for the same bond.

**Safe retry (with key):**

```bash
curl -X POST https://api.credence.io/api/payouts \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: payout-2026-07-28-bond-abc" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "bondId": "bond_abc",
    "amount": "100.00",
    "transactionHash": "0x...",
    "settledAt": "2026-07-28T12:00:00Z",
    "status": "completed"
  }'
```

---

## Endpoints NOT safe to retry without an idempotency key

These POST endpoints create or mutate resources without idempotency protection (unless you send the `Idempotency-Key` header). Retrying them without a key risks duplicate side effects.

| Endpoint | Method | Risk |
|----------|--------|------|
| `/api/attestations` | POST | Duplicate attestations |
| `/api/bulk/attestations` | POST | Duplicate bulk attestations |
| `/api/payouts` | POST | Duplicate payouts |
| `/api/admin/roles/assign` | POST | Duplicate role assignment logs |
| `/api/admin/keys/revoke` | POST | Redundant revocation response |
| `/api/admin/impersonate` | POST | Extra impersonation tokens |
| `/api/disputes` | POST | Duplicate dispute records |
| `/api/disputes/:id/review` | POST | Duplicate review actions |
| `/api/disputes/:id/resolve` | POST | Duplicate resolution actions |
| `/api/disputes/:id/dismiss` | POST | Duplicate dismiss actions |
| `/api/imports/commit` | POST | Duplicate import commits |
| `/api/imports/presets` | POST | Duplicate presets |
| `/api/reports` | POST | Duplicate report generation |

---

## How idempotency works under the hood

The idempotency middleware (`src/middleware/idempotency.ts`) implements the pattern:

1. Client sends `Idempotency-Key: <unique-value>` header
2. Server computes `bound_key = sha256(actor_id || payload_hash)`
3. Server looks up the key in the `idempotency_keys` table
4. If found with matching bound key → replay cached response
5. If found with mismatched key → return `409 Conflict` (`idempotency_key_mismatch`)
6. If not found → execute handler, cache response, return it

Cached responses are stored for 24 hours (configurable via `IDEMPOTENCY_TTL_SECONDS`).

See [docs/IDEMPOTENCY_GUARD.md](IDEMPOTENCY_GUARD.md) for the message-queue level idempotency (separate from request-level idempotency).

## Error codes related to retries

| Code | Meaning | Action |
|------|---------|--------|
| `idempotency_key_mismatch` (409) | Key is bound to a different payload | Use a fresh key or re-send the original payload |
| `service_unavailable` (503) | Service in maintenance mode | Retry after delay; GET requests are safe |
| `validation_failed` (400) | Invalid request body | Fix the request, then retry with same key |

## Related docs

- **[Idempotency Guard](IDEMPOTENCY_GUARD.md)** — duplicate message detection for at-least-once queue consumers (infrastructure-level, not HTTP-level)
- **[API & Endpoint Deprecation Policy](DEPRECATION_POLICY.md)** — how deprecated endpoints are communicated and eventually removed
- **[API Stability & Versioning](API_STABILITY.md)** — what constitutes a breaking change vs. backward-compatible addition
- **[Timeout Budgets & Retry Policies](timeouts-and-retries.md)** — outbound retry policies, timeout budgets, and error classification for downstream service calls
- **[Input Validation Guide](INPUT_VALIDATION.md)** — how request shape validation works (400 responses are safe to retry with corrected body)