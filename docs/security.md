# Security

## Rate Limiting

Credence enforces tiered, per-key rate limiting on all `/api/*` routes to prevent
abuse and ensure fair resource allocation across tenants.

### Architecture

Two independent **fixed-window counters** are checked per request:

| Counter       | Redis key format                    | Scope                                                                 |
| ------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Tenant bucket | `ratelimit:api:tenant:<tenantId>`   | Enforces the tier ceiling shared across **all** keys of the same owner |
| Key bucket    | `ratelimit:api:key:<keyId>:<tier>`  | Prevents a **single** noisy key from exhausting the shared tenant budget |

The key bucket includes the subscription tier in its Redis key so that a key
changing tiers (e.g. upgrading from `free` to `pro`) receives a fresh counter
scoped to the new tier.  A request is rejected with HTTP `429` when **either**
counter exceeds its limit.

### Tiers

| Tier         | Default limit (per 60 s window) | Configurable via                       |
| ------------ | ------------------------------- | -------------------------------------- |
| `free`       | 100 requests                    | `RATE_LIMIT_MAX_FREE`                  |
| `pro`        | 1 000 requests                  | `RATE_LIMIT_MAX_PRO`                   |
| `enterprise` | 10 000 requests                 | `RATE_LIMIT_MAX_ENTERPRISE`            |

### Fail-open vs Fail-closed

When Redis is unreachable the rate limiter must decide whether to allow or block
traffic.  This behaviour is controlled by `RATE_LIMIT_FAIL_OPEN`:

| Mode        | `RATE_LIMIT_FAIL_OPEN`          | Redis-down behaviour                        | Default                        |
| ----------- | ------------------------------- | ------------------------------------------- | ------------------------------ |
| **Fail-closed** | `false`                    | Returns `503 Service Unavailable`           | **Production** (safe default)  |
| **Fail-open**   | `true`                     | Passes the request through with full budget | Dev / test environments        |

**Security rationale:** Fail-closed is the safe default in production.  If an
attacker can trigger a Redis outage (e.g. via resource exhaustion), fail-open
would let them bypass rate limiting entirely and hammer the API without
restriction.  With fail-closed, the attack surface shrinks: Redis down means
the API is unavailable rather than unprotected.

### Startup Validation

The application performs the following safety checks at startup:

1. **Config validation** (`src/config/index.ts`): The `envSchema.superRefine`
   rejects production deployments that explicitly set
   `RATE_LIMIT_FAIL_OPEN=true` or `AUTH_RATE_LIMIT_FAIL_OPEN=true`.
   This prevents operators from accidentally deploying with rate limiting
   disabled during Redis outages.

2. **Catch-block fallback** (`src/app.ts`): If environment validation throws
   (e.g. missing required vars), the fallback defaults to **fail-closed** in
   production (`failOpen: false`) and logs an error-level message so the issue
   is visible in monitoring.

3. **Per-route helpers**: The `rateLimit()` backward-compatible helper also
   defaults fail-closed in production unless explicitly overridden.

### Response Headers

| Header                  | Description                                               |
| ----------------------- | --------------------------------------------------------- |
| `X-RateLimit-Limit`     | Max requests allowed in the current window                |
| `X-RateLimit-Remaining` | Requests remaining (tighter of tenant vs key budget)      |
| `X-RateLimit-Reset`     | Unix timestamp when the window resets                     |
| `Retry-After`           | Seconds before retrying (only on `429`)                   |

### Prometheus Metrics

| Metric                         | Labels                  | Description                              |
| ------------------------------ | ----------------------- | ---------------------------------------- |
| `rate_limit_rejected_total`    | `tier`, `key_id`, `reason` | Counter of rejected requests by rejection reason (`tenant_limit`, `key_limit`, `redis_unavailable`) |
| `rate_limit_hits_total`        | `tenant`, `tier`         | Counter of rate limit hits by tenant and tier |

### X-Forwarded-For Spoofing Prevention

The rate limiter uses `req.socket.remoteAddress` (the TCP-layer peer address)
instead of `req.ip` to determine the client IP.  When Express `trust proxy` is
enabled, `req.ip` is derived from the leftmost `X-Forwarded-For` entry — which
is fully attacker-controlled.  Using `socket.remoteAddress` eliminates this
attack vector; an adversary cannot rotate their IP by forging headers.

### Tenant Isolation

Each authenticated tenant's rate limit is tracked independently.
Unauthenticated requests are rate-limited per IP address (via
`socket.remoteAddress`).  Tenant overrides (configured via the admin
`/api/admin/rate-limit-overrides` endpoints) can raise or lower the effective
tier ceiling on a per-tenant basis without affecting other tenants.

### Environment Variables

| Variable                       | Default (dev) | Default (prod) | Description                             |
| ------------------------------ | ------------- | -------------- | --------------------------------------- |
| `RATE_LIMIT_ENABLED`           | `true`        | `true`         | Master switch for API rate limiting     |
| `RATE_LIMIT_WINDOW_SEC`        | `60`          | `60`           | Fixed-window duration in seconds        |
| `RATE_LIMIT_MAX_FREE`          | `100`         | `100`          | Requests per window for free tier       |
| `RATE_LIMIT_MAX_PRO`           | `1000`        | `1000`         | Requests per window for pro tier        |
| `RATE_LIMIT_MAX_ENTERPRISE`    | `10000`       | `10000`        | Requests per window for enterprise tier |
| `RATE_LIMIT_FAIL_OPEN`         | `true`        | `false`        | Redis-down behaviour (see above)        |
| `AUTH_RATE_LIMIT_ENABLED`      | `true`        | `true`         | Master switch for auth rate limiting    |
| `AUTH_RATE_LIMIT_WINDOW_SEC`   | `60`          | `60`           | Auth rate-limit window duration         |
| `AUTH_RATE_LIMIT_MAX_PER_TENANT` | `20`        | `20`           | Max auth requests per tenant per window |
| `AUTH_RATE_LIMIT_FAIL_OPEN`    | `true`        | `false`        | Auth rate-limit Redis-down behaviour    |

> **Warning:** Do not set `RATE_LIMIT_FAIL_OPEN=true` in production.  The
> application will refuse to start with this configuration.
