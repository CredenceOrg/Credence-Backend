# HTTP Status Reference

Every API error maps to an HTTP status code via the centralized error catalog
(`src/lib/errorCatalog.ts`). This document lists every status the API can
return, explains when a contributor should use each one, and shows the concrete
code path that produces it.

**Audience:** contributors adding or modifying endpoints. If you are building a
client against the API, see [API_ERROR_TAXONOMY.md](API_ERROR_TAXONOMY.md)
instead — it groups by category and gives consumer-facing remediation.

---

## How statuses are assigned

1. Create or reuse an entry in `ERROR_CATALOG` in `src/lib/errorCatalog.ts`.
   Every entry has a fixed `httpStatus`.
2. Throw the matching `AppError` subclass (or `new AppError(...)`) in your route
   handler. The global error handler in `src/middleware/errorHandler.ts` reads
   the catalog to set the response status and shape.
3. Never hard-code a status or response body in a route — always route through
   the catalog. This keeps the API consistent and the generated
   [error-codes.md](error-codes.md) accurate.

```typescript
// Route handler — throw an AppError; the middleware does the rest.
import { NotFoundError } from '../lib/errors.js'

app.get('/users/:id', async (req, res, next) => {
  const user = await findUser(req.params.id)
  if (!user) throw new NotFoundError('User', req.params.id)
  res.json(user)
})
```

---

## Status code reference

### 400 Bad Request

The request is malformed and cannot be processed. Retrying unchanged will always
fail.

| Catalog codes | Category | When it is used |
|---|---|---|
| `validation_failed`, `field_required`, `invalid_format`, `invalid_type`, `invalid_address`, `invalid_stellar_address`, `unexpected_field`, `value_too_small`, `value_too_large`, `unsafe_redirect_target`, `batch_size_too_small` | validation | Zod schema validation failed, a required field is missing, a field has the wrong type or format, or a redirect target is unsafe. |

```typescript
import { ValidationError } from '../lib/errors.js'

function validate(req: Request): void {
  const result = schema.safeParse(req.body)
  if (!result.success) {
    throw new ValidationError('Validation failed', result.error.issues)
  }
}
```

### 401 Unauthorized

The request lacks valid authentication credentials.

| Catalog codes | Category | When it is used |
|---|---|---|
| `unauthorized` | authentication | API key is missing, malformed, expired, or revoked. See [api-keys.md](api-keys.md). |

```typescript
import { UnauthorizedError } from '../lib/errors.js'

function requireAuth(req: Request): void {
  const key = req.headers['x-api-key']
  if (!key || !isValidKey(key)) {
    throw new UnauthorizedError()
  }
}
```

### 402 Payment Required

The caller has exceeded a consumption-based limit.

| Catalog codes | Category | When it is used |
|---|---|---|
| `insufficient_credits` | business | Monthly credit budget is exhausted. Never retry without human intervention. |

```typescript
import { AppError, ErrorCode } from '../lib/errors.js'

function checkCredits(tenant: Tenant): void {
  if (tenant.creditsRemaining <= 0) {
    throw new AppError(
      'Monthly credit budget exhausted',
      ErrorCode.INSUFFICIENT_CREDITS,
    )
  }
}
```

### 403 Forbidden

Credentials are valid but the caller lacks permission.

| Catalog codes | Category | When it is used |
|---|---|---|
| `forbidden` | authorization | Caller lacks the required scope or tenant access. |
| `crawler_blocked` | authorization | Automated crawling hits an admin-only surface. |
| `cors_blocked` | authorization | Cross-origin request blocked by per-route CORS policy. |

```typescript
import { ForbiddenError } from '../lib/errors.js'

function requireScope(scope: string, req: Request): void {
  if (!req.apiKey?.scopes.includes(scope)) {
    throw new ForbiddenError()
  }
}
```

### 404 Not Found

The addressed resource does not exist or is not visible to this tenant.

| Catalog codes | Category | When it is used |
|---|---|---|
| `not_found` | resource | Resource ID does not match any record, or the resource belongs to a different tenant. |

```typescript
import { NotFoundError } from '../lib/errors.js'

const user = await db.users.findById(id)
if (!user) throw new NotFoundError('User', id)
```

### 409 Conflict

The request conflicts with current resource state.

| Catalog codes | Category | When it is used |
|---|---|---|
| `conflict` | resource | Duplicate unique value or state prevents the operation. |
| `optimistic_lock_conflict` | resource | Another writer updated the resource between read and write. |
| `idempotency_key_mismatch` | business | `Idempotency-Key` is reused with a different actor or payload. |

```typescript
import { OptimisticLockError } from '../lib/errors.js'

function updateWithLock(resource: string, expectedVersion: number): void {
  const result = await db.resources.updateOne(
    { _id: resource, version: expectedVersion },
    { $inc: { version: 1 }, $set: updates },
  )
  if (result.matchedCount === 0) {
    throw new OptimisticLockError(resource, expectedVersion)
  }
}
```

### 413 Payload Too Large

The request body exceeds a server-configured size limit.

| Catalog codes | Category | When it is used |
|---|---|---|
| `batch_size_exceeded` | validation | Batch request exceeds the maximum item count. |
| `request_too_large` | validation | Request body exceeds the byte limit, or an export exceeds `EXPORT_MAX_ROWS`. |

```typescript
import { RequestTooLargeError } from '../lib/errors.js'

// Usually handled by Express body-parser config, but can be thrown explicitly:
function checkExportLimit(rowCount: number): void {
  if (rowCount > MAX_EXPORT_ROWS) {
    throw new RequestTooLargeError()
  }
}
```

### 422 Unprocessable Entity

The request is syntactically valid but the server cannot process it due to
domain logic or content restrictions.

| Catalog codes | Category | When it is used |
|---|---|---|
| `insufficient_funds` | business | Account balance is too low. |
| `invalid_dispute_transition` | business | Dispute state change is not allowed. |
| `ssrf_blocked` | validation | Target URL resolves to an internal/restricted address. |

```typescript
import { AppError, ErrorCode } from '../lib/errors.js'

function checkFunds(account: Account, amount: bigint): void {
  if (account.balance < amount) {
    throw new AppError(
      'Insufficient funds',
      ErrorCode.INSUFFICIENT_FUNDS,
    )
  }
}
```

### 429 Too Many Requests

The caller has exceeded a rate limit.

| Catalog codes | Category | When it is used |
|---|---|---|
| `rate_limit_exceeded` | rate_limit | Per-key or per-tenant rate limit is hit. |

Rate limiting is enforced by middleware (`src/middleware/rateLimiter.ts`). Route
handlers should never throw 429 themselves; the rate limiter does it
automatically.

### 500 Internal Server Error

An unexpected server-side failure occurred. The response is deliberately opaque.

| Catalog codes | Category | When it is used |
|---|---|---|
| `internal_server_error` | system | Unhandled exception or unexpected error (catch-all). |
| `missing_security_header` | system | A required security header was not set on the outbound response. |

Route handlers should never throw 500 directly — it is the global error
handler's fallback for any unhandled error. If you need to signal a system
failure, use `ServiceUnavailableError` (503) instead.

### 503 Service Unavailable

A dependency or the service itself is temporarily unable to handle requests.

| Catalog codes | Category | When it is used |
|---|---|---|
| `service_unavailable` | system | Database, Redis, or upstream API is unreachable, or the server is shutting down. |

```typescript
import { ServiceUnavailableError } from '../lib/errors.js'

async function checkDependencies(): Promise<void> {
  if (!(await redis.ping())) {
    throw new ServiceUnavailableError()
  }
}
```

---

## Quick-reference table

| Status | Category | Safe to retry? |
|---|---|---|
| 400 | validation | No |
| 401 | authentication | No |
| 402 | business | No |
| 403 | authorization | No |
| 404 | resource | No |
| 409 | resource / business | No (re-read first) |
| 413 | validation | No |
| 422 | business / validation | No |
| 429 | rate_limit | Yes, after `Retry-After` |
| 500 | system | Yes, with backoff |
| 503 | system | Yes, with backoff |

---

## Choosing a status for a new endpoint

1. Start from the error **category** (validation, authentication, etc.).
2. Pick the **HTTP status** that matches the category from the table above.
3. If no existing error code fits, add a new entry to `ERROR_CATALOG` in
   `src/lib/errorCatalog.ts` with the chosen status.
4. Add a convenience subclass in `src/lib/errors.ts` if the new code will be
   used in more than one place.
5. Run `npx tsx scripts/generate-error-docs.ts` to regenerate
   [error-codes.md](error-codes.md).
6. If the error introduces a new HTTP status or changes an existing envelope
   field, update the response example in the endpoint's OpenAPI entry and run
   `npm run generate:openapi`.

---

## Related documents

- [API_ERROR_TAXONOMY.md](API_ERROR_TAXONOMY.md) — consumer-facing reference (organized by category, with remediation).
- [error-codes.md](error-codes.md) — auto-generated table of every catalog entry (do not edit by hand).
- [VALIDATION.md](VALIDATION.md) — how Zod validation produces 400 errors.
- [src/lib/errorCatalog.ts](../src/lib/errorCatalog.ts) — source of truth for codes and statuses.
- [src/lib/errors.ts](../src/lib/errors.ts) — `AppError` base class and convenience subclasses.
- [src/middleware/errorHandler.ts](../src/middleware/errorHandler.ts) — global error-handling middleware.
