# Rate Limit Response Headers Specification & Semantics

> **Target Audience:** Downstream Integrators (API consumers, client SDK developers, and integration engineers)

This document provides the technical specification and semantics for HTTP response headers emitted by the rate limiting middleware in the Credence Backend.

---

## Overview

The Credence Backend uses a Redis-backed fixed-window rate limiter on all `/api/*` endpoints to protect against resource exhaustion and ensure fair usage across tenants. Every API response includes standardized HTTP headers informing clients of their rate limit budget, remaining requests, and window reset schedule.

When rate limits are exceeded, the API returns HTTP status `429 Too Many Requests` along with a `Retry-After` header indicating how long to pause before issuing subsequent requests.

---

## Response Headers Reference

The rate limiting middleware sets four standard response headers:

| Header Name | Type | Response Status | Description |
| :--- | :--- | :--- | :--- |
| `X-RateLimit-Limit` | Integer | Always | Maximum number of requests allowed in the current fixed window. |
| `X-RateLimit-Remaining` | Integer | Always | Remaining requests allowed in the current window before rejection (`>= 0`). |
| `X-RateLimit-Reset` | Unix Timestamp | Always | Epoch timestamp (in seconds) when the current rate limit window resets. |
| `Retry-After` | Integer | `429 Too Many Requests` | Time to wait (in seconds) before making another request. |

---

## Header Semantics & Calculation Rules

### 1. `X-RateLimit-Limit`

- **Definition:** The maximum request ceiling allocated to the caller for the current fixed window (`RATE_LIMIT_WINDOW_SEC`, default: 60 seconds).
- **Resolution:**
  - **Free Tier:** `100` requests / minute (default for IP fallback or unauthenticated requests).
  - **Pro Tier:** `1,000` requests / minute.
  - **Enterprise Tier:** `10,000` requests / minute.
  - **Per-Tenant Override:** Custom value configured by admins via `/api/admin/rate-limits/overrides`.
  - **Per-Key Override:** Explicit max limit defined on per-route or per-key configuration.

### 2. `X-RateLimit-Remaining`

- **Definition:** The number of requests left in the caller's budget for the current window.
- **Dual-Bucket Logic:**
  - The backend evaluates two independent fixed-window counters:
    1. **Tenant Counter:** Shared across all API keys belonging to the same tenant.
    2. **Key Counter:** Scoped strictly to the specific API key used for the request.
  - `X-RateLimit-Remaining` returns the **tighter (minimum)** of the two remaining budgets:
    $$\text{Remaining} = \max\left(0, \min\left(\text{Limit}_{\text{tenant}} - \text{Count}_{\text{tenant}}, \text{Limit}_{\text{key}} - \text{Count}_{\text{key}}\right)\right)$$
- **Fail-Open Behavior:**
  - When Redis is temporarily unavailable and `RATE_LIMIT_FAIL_OPEN=true` (development/staging), `X-RateLimit-Remaining` defaults to the full limit (`Limit`) to prevent unexpected client throttling.

### 3. `X-RateLimit-Reset`

- **Definition:** Unix epoch timestamp (in integer seconds) representing when the current window expires and the request counter resets.
- **Window Alignment:**
  - Fixed windows align to whole intervals of `windowSec`:
    $$\text{windowStart} = \text{now} - (\text{now} \pmod{\text{windowSec}})$$
    $$\text{resetTime} = \text{windowStart} + \text{windowSec}$$
- **Rate-Limited Requests (HTTP 429):**
  - Evaluated as `now + TTL`, where `TTL` is the time-to-live of the exhausted Redis key.

### 4. `Retry-After`

- **Definition:** Number of seconds the client MUST wait before retrying the request.
- **Presence:** Only included on `429 Too Many Requests` status codes.
- **Calculation:** Matches the Redis TTL of the limiting bucket (e.g., `42` seconds).

---

## Concrete Request & Response Examples

### Example 1: Successful Request (`200 OK`)

A client authenticated under a Pro Tier key (1,000 req/min limit) makes a GET request to `/api/v1/trust-score/0x71C7656EC7ab88b098defB751B7401B5f6d8976F`:

```http
GET /api/v1/trust-score/0x71C7656EC7ab88b098defB751B7401B5f6d8976F HTTP/1.1
Host: api.credence.network
Authorization: Bearer crd_live_9f8e7d6c5b4a3210

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 984
X-RateLimit-Reset: 1784937660

{
  "address": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  "score": 850,
  "tier": "Trusted"
}
```

### Example 2: Exceeded Quota Request (`429 Too Many Requests`)

A client on the Free Tier (100 req/min limit) exhausts their quota:

```http
GET /api/v1/attestations/att_123456789 HTTP/1.1
Host: api.credence.network
X-API-Key: crd_free_demo_key

HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1784937660
Retry-After: 42

{
  "error": "Rate limit exceeded. Try again later.",
  "code": "rate_limit_exceeded",
  "details": {
    "retryAfter": 42,
    "limit": 100,
    "windowSec": 60
  }
}
```

---

## Client Integration Guide

Downstream clients should inspect rate limit headers to implement exponential backoff, request queuing, or proactive throttling.

### TypeScript / JavaScript Integration Example

Below is a TypeScript client wrapper demonstrating how to parse rate limit headers and handle HTTP 429 responses correctly:

```typescript
export interface RateLimitInfo {
  limit: number
  remaining: number
  reset: number
  retryAfter?: number
}

export interface ApiResponse<T> {
  data?: T
  error?: string
  rateLimit: RateLimitInfo
}

/**
 * Parses standard rate limit headers from a Response object.
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
  const limit = parseInt(headers.get('X-RateLimit-Limit') ?? '0', 10)
  const remaining = parseInt(headers.get('X-RateLimit-Remaining') ?? '0', 10)
  const reset = parseInt(headers.get('X-RateLimit-Reset') ?? '0', 10)
  const retryAfterHeader = headers.get('Retry-After')
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined

  return { limit, remaining, reset, retryAfter }
}

/**
 * Example fetch wrapper with automatic rate limit backoff.
 */
export async function fetchWithRateLimit<T>(
  url: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const response = await fetch(url, options)
  const rateLimit = parseRateLimitHeaders(response.headers)

  if (response.status === 429) {
    const waitSeconds = rateLimit.retryAfter ?? Math.max(1, rateLimit.reset - Math.floor(Date.now() / 1000))
    console.warn(`[RateLimit] 429 received. Waiting ${waitSeconds}s before retrying...`)
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000))
    return fetchWithRateLimit<T>(url, options)
  }

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string }
    return { error: errorBody.error ?? 'Request failed', rateLimit }
  }

  const data = (await response.json()) as T
  return { data, rateLimit }
}
```

---

## Related Documentation

- **[Operations & Support Guide](rate-limiting.md)** — Operational runbook, troubleshooting FAQ, Prometheus metrics, and tenant overrides.
- **[Rate Limiting Design](RATE_LIMITING_DESIGN.md)** — Architectural design and dual-bucket specification.
- **[API Reference Guide](api.md)** — Complete endpoint definitions and general error schemas.
