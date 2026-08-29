# Idempotency Keys — Payout Create

> **Issue #941** · Backend-only · Secure · Tested

Prevent duplicate payouts on client retries by attaching an `Idempotency-Key`
request header to `POST /api/payouts`. The backend stores the first successful
response against a payload-hash–bound key; any subsequent request with the same
key is short-circuited and the cached response is returned.

---

## Table of contents

1. [Quick start](#quick-start)
2. [Header contract](#header-contract)
3. [How it works](#how-it-works)
4. [Security guarantees](#security-guarantees)
5. [Expiry and cleanup](#expiry-and-cleanup)
6. [Error reference](#error-reference)
7. [Database schema](#database-schema)
8. [Implementation reference](#implementation-reference)

---

## Quick start

```bash
# First attempt — processes the payout and stores the key
curl -X POST https://api.example.com/api/payouts \
  -H "x-api-key: <YOUR_KEY>" \
  -H "Idempotency-Key: payout-$(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"bondId":"bond-123","amount":"42.50","transactionHash":"0xabc..."}'
# → 201 Created  { "success": true, "data": { "id": "…", … } }

# Client times out — safe to retry with the SAME Idempotency-Key
curl -X POST https://api.example.com/api/payouts \
  -H "x-api-key: <YOUR_KEY>" \
  -H "Idempotency-Key: payout-<SAME-UUID>" \
  -H "Content-Type: application/json" \
  -d '{"bondId":"bond-123","amount":"42.50","transactionHash":"0xabc..."}'
# → 201 Created  { "success": true, "data": { "id": "…", … } }   ← same cached body
```

---

## Header contract

| Header | Required | Notes |
|--------|----------|-------|
| `Idempotency-Key` | No | If omitted the request is processed normally with no dedup |

**Key format:** any string up to 255 characters; UUIDs are recommended
(`crypto.randomUUID()` in Node, `uuid` library, etc.).

**Key scope:** keys are per-endpoint and per-actor — a key issued for
`POST /api/payouts` cannot be replayed by a different API key holder.

---

## How it works

```
Client                 Middleware              IdempotencyRepository        Handler
  │                       │                           │                       │
  │── POST /api/payouts ──►│                           │                       │
  │   Idempotency-Key: K   │                           │                       │
  │                       │── findByKey(K) ──────────►│                       │
  │                       │                           │── SELECT … WHERE key = K AND
  │                       │                           │        expires_at > NOW()
  │                       │◄─ null (first time) ──────│                       │
  │                       │                           │                       │
  │                       │── intercepts res.json() ─►│                       │
  │                       │──────────────────────────────────────────────────►│
  │                       │◄── 201 { success, data } ─────────────────────────│
  │                       │── save(K, actor, hash, 201, body) ──────────────►│
  │◄── 201 ───────────────│                           │                       │
  │                       │                           │                       │
  │── POST /api/payouts ──►│   ← retry with same K    │                       │
  │                       │── findByKey(K) ──────────►│                       │
  │                       │◄─ {responseCode:201, …} ──│                       │
  │◄── 201 (cached) ──────│   ← short-circuit         │                       │
```

### Detailed flow

1. Extract the `Idempotency-Key` header.  If absent, pass through unchanged.
2. Compute `actorId` from the authenticated identity (API key ID or user ID;
   falls back to `"anonymous"`).
3. Compute `payloadHash = sha256(canonicalStringify(req.body))`.
4. Compute `boundKeyHash = sha256(actorId + ":" + payloadHash)`.
5. Look up the key in `idempotency_keys` (only non-expired rows are returned).
6. **Key found** — compare stored `boundKeyHash` against the incoming one:
   - **Match** → replay stored `(responseCode, responseBody)`.
   - **Mismatch** → return `409 IDEMPOTENCY_KEY_MISMATCH`.
7. **Key not found** — intercept `res.json()`, forward the request to the
   handler, then persist the response (only when `statusCode < 500`).

---

## Security guarantees

### Payload-hash binding
The idempotency key is cryptographically bound to both the **actor** and the
**request payload**.  Changing any field in the body (amount, bondId, etc.)
produces a different hash and causes a `409` rather than silently processing
incorrect data.

### Actor binding
The key is further bound to the **authenticated actor** (API key ID or user ID).
A stolen key cannot be replayed by a different actor — the `boundKeyHash`
check will fail and return `409`.

### Timing-attack resistance
The hash comparison uses a constant-time XOR loop (`constantTimeEquals`) rather
than JavaScript's `===` operator, which short-circuits on the first differing
byte and could leak information about the stored hash.

### No caching of 5xx responses
The middleware intercepts `res.json()` and only persists the key when
`statusCode < 500`.  Transient server errors are never cached, so a retry after
a backend failure processes the request fresh.

### 4xx responses are purged
`IdempotencyRepository.save()` automatically deletes the key when the response
code is `≥ 400`, ensuring that a validation-failed request does not block a
corrected retry.

---

## Expiry and cleanup

| Setting | Default | Override |
|---------|---------|---------|
| Key TTL | 24 hours (86 400 s) | Pass `expiresInSeconds` to `idempotencyMiddleware()` |

Expired keys are cleaned up by `IdempotencyKeySweeper` — a background job
that runs hourly and deletes rows where `expires_at ≤ NOW()`.  The `expires_at`
column is indexed to keep the delete query efficient.

After a key expires, a client can reuse the same key string to create a new
payout.  The previous response is no longer available.

---

## Error reference

| HTTP | `error_code` | Cause |
|------|-------------|-------|
| `409 Conflict` | `IDEMPOTENCY_KEY_MISMATCH` | Key was already issued to a different actor **or** a different payload hash |

### 409 response body

```json
{
  "error":      "Conflict",
  "error_code": "IDEMPOTENCY_KEY_MISMATCH",
  "code":       "IDEMPOTENCY_KEY_MISMATCH",
  "message":    "Idempotency key is already bound to a different actor or payload",
  "statusCode": 409
}
```

**Client guidance:** generate a new `Idempotency-Key` if you intentionally want
to create a different payout.  Do **not** reuse the same key with a different
body.

---

## Database schema

### `idempotency_keys` (migration `004_create_idempotency_keys`)

| Column | Type | Description |
|--------|------|-------------|
| `key` | `text` PK | Client-supplied idempotency key |
| `actor_id` | `text` NOT NULL | API key ID or user ID at time of first request |
| `request_hash` | `text` NOT NULL | SHA-256 of the canonical request body |
| `response_code` | `integer` NOT NULL | HTTP status returned to the client |
| `response_body` | `jsonb` NOT NULL | Serialised response body |
| `ttl_seconds` | `integer` NOT NULL | TTL configured at write time |
| `expires_at` | `timestamptz` NOT NULL | Absolute expiry timestamp |
| `created_at` | `timestamptz` NOT NULL | Row insertion time |

`actor_id` and `ttl_seconds` were added in migration
`026_add_idempotency_actor_ttl_columns`.

Index: `idempotency_keys(expires_at)` — used by the sweeper job.

---

## Implementation reference

| Component | Location |
|-----------|---------|
| Middleware | `src/middleware/idempotency.ts` |
| Repository | `src/db/repositories/idempotencyRepository.ts` |
| Hash utility | `src/utils/hash.ts` (`computeRequestHash`, `computeStableHash`) |
| Migration (table) | `src/migrations/004_create_idempotency_keys.ts` |
| Migration (actor/TTL) | `src/migrations/026_add_idempotency_actor_ttl_columns.ts` |
| Sweeper job | `src/jobs/idempotencyKeySweeper.ts` |
| Payout route (wired) | `src/routes/payouts.ts` |
| Unit tests | `src/routes/payouts.test.ts` |
| Integration tests | `tests/integration/payoutIdempotency.integration.test.ts` |

### Wiring the middleware to a new route

```typescript
import { idempotencyMiddleware } from '../middleware/idempotency.js'
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'
import { pool } from '../db/pool.js'

const idempotencyRepo = new IdempotencyRepository(pool)

router.post(
  '/my-endpoint',
  requireApiKey(ApiScope.WRITE),
  idempotencyMiddleware(idempotencyRepo, { expiresInSeconds: 86400 }),
  validate({ body: mySchema }),
  async (req, res, next) => { /* handler */ }
)
```
