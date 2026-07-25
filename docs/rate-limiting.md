# Rate Limiting: Operations & Support Guide

This guide documents the rate limiting architecture of the Credence Backend, including limits for each subscription tier, environment configuration, observability metrics, and troubleshooting steps for support teams to answer client queries (e.g., "Why did I get a 429 error?").

---

## Overview

The Credence Backend protects the API from denial-of-service (DoS) attacks, brute-forcing, and accidental resource exhaustion using a Redis-backed **fixed-window rate limiting** middleware. 

Rate limits are evaluated at the `/api` route prefix. All requests targeting endpoints under this path are counted against the caller's subscription tier quota.

---

## Dual-Bucket Architecture

To prevent a single compromised or misbehaving API key from exhausting the entire tenant's request budget, the rate limiter enforces a **dual-bucket** check. Two independent fixed-window counters are incremented and evaluated for each incoming request:

1. **Tenant-Level Bucket (Tier Ceiling)**: 
   - Shared across **all** API keys belonging to the same tenant (owner).
   - Key format in Redis: `ratelimit:<namespace>:tenant:<ownerId>:<windowStart>`
   - Prevents the tenant as a whole from exceeding their contract tier ceiling.
2. **API Key-Level Bucket (Key Ceiling)**:
   - Scoped strictly to the **individual API key** used for the request.
   - Key format in Redis: `ratelimit:<namespace>:key:<keyId>:<windowStart>`
   - Prevents a single client implementation using one key from shutting down other services under the same tenant account.

A request is rejected with **HTTP 429 Too Many Requests** when **either** of these buckets is exceeded.

---

## Subscription Tier Limits

The platform maps caller authentication tokens or API keys to three subscription tiers: **Free**, **Pro**, and **Enterprise**. 

The default limits are based on a **60-second window** (1 minute):

| Subscription Tier | Requests / Min | Description |
| :--- | :--- | :--- |
| **Free** | **100** | Default tier for non-paying users or sandbox keys. |
| **Pro** | **1,000** | Professional tier for production integrations. |
| **Enterprise** | **10,000** | High-throughput tier for large-scale enterprise partners. |

> [!NOTE]
> For unauthenticated requests (such as endpoints accessed without a valid API key), the rate limiter falls back to limiting by the client's IP address (`ip:<ipAddress>`) at the **Free** tier rate limit.

---

## Response Headers

Every successful API response includes metadata headers describing the current rate limit window state. When a rate limit is exceeded, a `Retry-After` header is additionally supplied.

| Header | Type | Description |
| :--- | :--- | :--- |
| `X-RateLimit-Limit` | Integer | The maximum requests allowed in the current window (e.g. `1000`). |
| `X-RateLimit-Remaining` | Integer | The remaining number of requests allowed for this window. For dual-bucket requests, this reflects the **tighter** of the two budgets. |
| `X-RateLimit-Reset` | Unix Timestamp | The epoch timestamp (seconds) when the current window resets. |
| `Retry-After` | Integer | (Only returned on HTTP 429) The number of seconds the client must wait before making another request. |

### Example Header Set (Normal Request)
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 998
X-RateLimit-Reset: 1784937660
```

### Example Header Set (Rate-Limited Request)
```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1784937660
Retry-After: 42
```

---

## Error Response Body

When a rate limit is exceeded, the server returns an HTTP 429 status code with a standardized JSON error body matching the following schema:

```json
{
  "error": "Rate limit exceeded. Try again later.",
  "code": "rate_limit_exceeded",
  "details": {
    "retryAfter": 42,
    "limit": 1000,
    "windowSec": 60
  }
}
```

---

## Configuration Reference

Operators can tune the rate limiting parameters in the environment (`.env`) without changing code.

| Environment Variable | Default Value | Description |
| :--- | :--- | :--- |
| `RATE_LIMIT_ENABLED` | `true` | Enables or disables the rate limiting middleware entirely. |
| `RATE_LIMIT_WINDOW_SEC` | `60` | The fixed-window duration in seconds. |
| `RATE_LIMIT_MAX_FREE` | `100` | Quota limit per window for the Free tier. |
| `RATE_LIMIT_MAX_PRO` | `1000` | Quota limit per window for the Pro tier. |
| `RATE_LIMIT_MAX_ENTERPRISE` | `10000` | Quota limit per window for the Enterprise tier. |
| `RATE_LIMIT_FAIL_OPEN` | `false` (Prod)<br>`true` (Dev) | **Security Feature:** If Redis is down, fail-open (`true`) allows requests through to prevent service disruption; fail-closed (`false`) blocks requests with HTTP 503 to ensure security. |

---

## Observability

### Prometheus Metrics
Operators should monitor rate limiter activity using these Prometheus metrics exposed on `/metrics`:

- **`rate_limit_rejected_total`** (Counter): Total requests rejected by the rate limiter.
  - Labels:
    - `tier`: `free`, `pro`, `enterprise`
    - `key_id`: The database ID of the API key, or `none`
    - `reason`: `tenant_limit` (tenant ceiling hit), `key_limit` (individual key ceiling hit), or `redis_unavailable` (when Redis is down and `RATE_LIMIT_FAIL_OPEN` is false)
- **`rate_limit_hits_total`** (Counter): Incremented when a tenant/IP has exceeded their rate limit.
  - Labels:
    - `tenant`: The tenant ID, or `unknown`
    - `tier`: `free`, `pro`, `enterprise`

### Searching Logs
When auditing rate limit rejections in the structured application logs, search for:
- Message: `Rate limit exceeded`
- Error Code: `rate_limit_exceeded`

---

## Support Troubleshooting FAQ ("Why 429?")

When a customer contacts support complaining about receiving `429 Too Many Requests` or `rate_limit_exceeded` errors, follow this diagnostic guide:

### Q1: The customer says: "We are on the Pro tier, but we are hitting rate limits. Why?"
**Answer**: 
- **Verify the limit**: Check their headers or the error response details. A Pro user has a limit of **1,000 requests per minute**.
- **Check for noisy keys**: Under the dual-bucket model, a tenant limit is shared across **all** of their API keys. If the tenant has 3 keys running simultaneously, and Key A makes 800 requests while Key B makes 200 requests within the same minute, any further requests from any key under that tenant will trigger a `429` (reason: `tenant_limit`), even if Key C has made 0 requests.
- **Check IP fallback**: If the client's application failed to pass the `X-API-Key` or `Authorization` header, the request fell back to their IP address, which restricts them to the Free tier rate limit (**100 requests per minute**). Check if they are passing the authentication credentials correctly.

### Q2: How can support verify which bucket triggered the 429?
**Answer**:
Look at the Prometheus metric `rate_limit_rejected_total` filtered by the customer's `key_id`.
- If the `reason` label is `key_limit`, the specific API key exceeded its own limit.
- If the `reason` label is `tenant_limit`, the overall tenant's quota was exhausted by the sum of requests from all keys belonging to that tenant.

### Q3: A customer complains they get a `503 Service Unavailable` with `rate limiter unavailable` instead of a 429.
**Answer**:
This indicates that the backend cannot communicate with its Redis cache, and the system is operating in **fail-closed** mode (which is the default security behavior in production environments). Check the Redis cluster status and network latency. The application logs will contain connection timeout or connection refused errors for Redis.

### Q4: Can we increase the rate limit temporarily for a single tenant?
**Answer**:
Yes. Admins can configure per-tenant rate limit overrides via the Admin API:
- `POST /api/admin/rate-limits/overrides`: Sets or updates a tenant's custom rate limit (`rateLimit`, `windowSize`, `reason`).
- `DELETE /api/admin/rate-limits/overrides/:tenantId`: Removes a tenant's custom rate limit override (`reason`).

---

## Per-Tenant Rate Limit Overrides & Audit Trail

To support custom SLAs or high-volume campaigns without changing global tier defaults, admins can set per-tenant rate limit overrides.

### Mandatory Audit Logging
Every override operation (`SET_RATE_LIMIT_OVERRIDE` or `REMOVE_RATE_LIMIT_OVERRIDE`) records an immutable entry in the audit trail (`audit_logs` table) containing:
- **actor**: Admin user ID (`actorId`) and email (`actorEmail`).
- **tenant**: Target tenant ID (`tenantId`).
- **old/new value**: `oldRateLimit`, `newRateLimit`, `oldWindowSize`, `newWindowSize`.
- **reason**: Mandatory justification string explaining why the override was applied or removed.
- **timestamp**: ISO8601 creation timestamp (`occurred_at`).

