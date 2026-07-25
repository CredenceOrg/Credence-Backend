# API Error Taxonomy

Canonical list of every public error code, its HTTP status, and the remediation
path for each. Written for **downstream integrators** building clients against
the Credence API.

The machine-readable source of truth is `src/lib/errorCatalog.ts`; the generated
code/status/message table lives in [error-codes.md](error-codes.md) (do not edit
that file by hand). This document adds what the generated reference does not:
**what each error means and what to do about it.**

## Response envelope

All API errors share one JSON envelope, produced by the global error handler
(`src/middleware/errorHandler.ts`):

```json
{
  "error": "Validation failed",
  "code": "validation_failed",
  "error_code": "validation_failed",
  "details": [{ "path": "amount", "message": "Expected number" }]
}
```

- `code` and `error_code` are aliases carrying the same stable machine-readable
  string. Branch on `code`; never parse `error`.
- In **production** (`NODE_ENV=production`), `error` is always the catalog
  default message and `details` is omitted, so responses never leak PII, stack
  traces, or chained internals. In non-production, `error` may carry the
  original message and `details` may include structured context (e.g. Zod
  issue lists).
- Any uncatalogued or unexpected failure is collapsed to
  `internal_server_error` (500) with the catalog default message.

## Retry policy at a glance

| Category | HTTP statuses | Retry? |
| --- | --- | --- |
| `validation` | 400, 413 | No — fix the request first. |
| `authentication` | 401 | No — fix credentials first. |
| `authorization` | 403 | No — fix scopes/permissions first. |
| `resource` | 404, 409 | No for 404; 409 see per-code guidance. |
| `business` | 402, 409, 422 | No — state or funds must change first. |
| `rate_limit` | 429 | Yes, after `Retry-After` seconds. |
| `system` | 500, 503 | Yes, with exponential backoff + jitter. |

## Validation errors (400 / 413)

The request itself is malformed. Retrying unchanged will fail identically.

| Code | HTTP | Meaning | Remediation |
| --- | ---: | --- | --- |
| `validation_failed` | 400 | Schema validation failed (Zod). Non-production `details` is an array of `{ path, message }` issues. | Fix the fields named in `details`. See [VALIDATION.md](VALIDATION.md). |
| `field_required` | 400 | A required field is missing. | Add the field; compare against the endpoint schema in [openapi.yaml](openapi.yaml). |
| `invalid_format` | 400 | A field has the wrong format (e.g. bad timestamp, UUID, hash). | Reformat per the endpoint schema. |
| `invalid_type` | 400 | A field has the wrong JSON type (string vs number, etc.). | Coerce client-side before sending. |
| `unexpected_field` | 400 | The body contains a field the endpoint does not accept. | Strip unknown fields; check for typos. |
| `value_too_small` | 400 | A value is below the allowed minimum. | Clamp to the documented minimum. |
| `value_too_large` | 400 | A value is above the allowed maximum. | Clamp to the documented maximum. |
| `invalid_address` | 400 | An address field is not a valid address. | Validate/normalize the address client-side. |
| `invalid_stellar_address` | 400 | A Stellar address failed checksum/format validation. | Verify it is a strkey-encoded ed25519 public key (`G...`, 56 chars). |
| `batch_size_too_small` | 400 | A batch request is below the minimum item count. | Add items or use the single-item endpoint. |
| `batch_size_exceeded` | 413 | A batch request exceeds the maximum item count. | Split into smaller batches. |
| `request_too_large` | 413 | The request body exceeds the configured size limit. | Reduce payload size; for evidence uploads see [evidence-upload-security.md](evidence-upload-security.md). |

## Authentication and authorization (401 / 403)

| Code | HTTP | Meaning | Remediation |
| --- | ---: | --- | --- |
| `unauthorized` | 401 | Missing, malformed, or invalid credentials. | Send a valid API key; check key formatting and expiry. See [api-keys.md](api-keys.md). |
| `forbidden` | 403 | Credentials are valid but lack the required scope/permission, or tenancy does not match. | Request the needed scope on the key; verify you are acting in the right tenant. See [rbac.md](rbac.md) and [multi-tenancy.md](multi-tenancy.md). |

Do not retry either code in a loop — fix the credential or scope first.

## Resource errors (404 / 409)

| Code | HTTP | Meaning | Remediation |
| --- | ---: | --- | --- |
| `not_found` | 404 | The addressed resource does not exist (or is not visible to your tenant). | Verify the ID and tenant context; list resources instead of guessing IDs. |
| `conflict` | 409 | The request conflicts with current resource state (e.g. duplicate unique value, concurrent modification). | Re-read the resource, resolve the conflict, and retry once. |

## Business errors (402 / 409 / 422)

The request is well-formed but rejected by domain rules. Retrying unchanged
will fail identically.

| Code | HTTP | Meaning | Remediation |
| --- | ---: | --- | --- |
| `insufficient_credits` | 402 | Monthly credit budget exhausted. | Wait for the next billing window or raise the budget; check usage before sending. |
| `insufficient_funds` | 422 | The account cannot cover the operation. | Fund the account, then retry. |
| `invalid_dispute_transition` | 422 | The requested dispute state transition is not allowed from the current state. | Fetch the dispute, follow the allowed transitions for its current state. |
| `idempotency_key_mismatch` | 409 | The `Idempotency-Key` was already used with a **different** actor or payload. | Never reuse a key across different payloads. Re-send the **original** payload with the same key to get the original response, or use a fresh key. See [IDEMPOTENCY_GUARD.md](IDEMPOTENCY_GUARD.md). |

## Rate limiting (429)

| Code | HTTP | Meaning | Remediation |
| --- | ---: | --- | --- |
| `rate_limit_exceeded` | 429 | Per-key or per-tenant rate limit hit. | Sleep for `Retry-After` seconds, then retry. Track `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` on every response to throttle proactively. |

The limiter emits both tenant-level and key-level limits; non-production
`details` includes `{ retryAfter, limit, windowSec }`.

## System errors (500 / 503)

| Code | HTTP | Meaning | Remediation |
| --- | ---: | --- | --- |
| `internal_server_error` | 500 | Unexpected server-side failure (deliberately opaque). | Retry with exponential backoff + jitter (e.g. 1s, 2s, 4s, capped at ~30s, max ~5 attempts). If persistent, report with the timestamp and endpoint. |
| `service_unavailable` | 503 | A dependency or the service itself is temporarily down. | Same backoff policy; check status/monitoring before escalating. |

Only `system` and `rate_limit` errors are safe to retry without changing the
request. Always honor idempotency keys when retrying mutating endpoints.

## SDK transport errors (no HTTP status)

The TypeScript SDK (`src/sdk/`, see [sdk.md](sdk.md)) also surfaces
`kind: 'transport'` errors that never produce an HTTP response:

| Code | Meaning | Remediation |
| --- | --- | --- |
| `sdk_request_timeout` | The request exceeded the client timeout. | Retry with backoff; increase the timeout for slow endpoints. |
| `sdk_network_error` | DNS/TCP/TLS failure before any response. | Check connectivity; retry with backoff. |
| `sdk_invalid_json` | The response body was not valid JSON. | Treat as a server fault; retry, then report if persistent. |
| `sdk_unmapped_http` | An HTTP error status with no catalog mapping (fallback). | Inspect the raw status/body; usually indicates a proxy or version mismatch. |

## Deprecation contract

Error-code strings are stable public API values:

- New codes may be added in minor releases — clients must tolerate unknown
  codes (treat them as `internal_server_error`).
- Existing codes are never removed or renamed without an entry in
  `ERROR_CODE_DEPRECATIONS` in `src/lib/errorCatalog.ts` documenting the
  replacement and migration path.
- The legacy `invalid_input` code is deprecated in the catalog in favor of
  `validation_failed`; do not emit or branch on it in new integrations.

## Related documents

- [error-codes.md](error-codes.md) — generated code/status/message table (source of truth for the wire strings).
- [VALIDATION.md](VALIDATION.md) — request validation behavior and `details` shape.
- [IDEMPOTENCY_GUARD.md](IDEMPOTENCY_GUARD.md) — idempotency-key semantics.
- [api-keys.md](api-keys.md), [rbac.md](rbac.md) — credentials and scopes.
- [openapi.yaml](openapi.yaml) — per-endpoint schemas.
