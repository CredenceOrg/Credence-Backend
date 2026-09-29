# Cross-Origin Resource Sharing (CORS) Policy — Per-Route Reference

> **Audience:** Security auditors, platform operators, and contributors reviewing cross-origin access controls.
> **Last updated:** 2026-07-25

---

## Threat Model

The primary threat mitigated by a **per-route CORS policy** is **cross-origin data exfiltration and state-modifying requests from untrusted origins** — an attacker who can lure a victim into visiting a malicious website (or who can inject content into an allowed origin) could:

- **Read sensitive data** from authenticated endpoints by making cross-origin `GET` requests and reading the response via JavaScript (e.g., reading trust scores, audit logs, or evidence metadata from a different origin).
- **Perform state-changing actions** via cross-origin `POST`/`PUT`/`DELETE` requests if the victim has an active session or API key stored in the browser (e.g., creating payouts, revoking keys, uploading evidence, impersonating users).
- **Leak JWKS or version metadata** that could aid fingerprinting, though these endpoints intentionally expose no sensitive data.
- **Bypass network segmentation** if the API is deployed behind a reverse proxy that trusts all origins equally.

All of these are defence-in-depth controls. Even though no public exploitation of these gaps has been reported, a careful auditor would flag any endpoint whose CORS policy is wider than necessary.

### What an attacker gains if this check is missing

| Route Group                       | Attacker Action                                                   | Impact                                |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| `/api/admin/*`                    | Cross-origin POST to rotate keys, assign roles, impersonate users | **Critical** — full platform takeover |
| `/api/payouts/*`                  | Cross-origin POST to initiate payouts                             | **High** — financial loss             |
| `/api/evidence/*`                 | Cross-origin GET/POST to read or upload encrypted evidence        | **High** — sensitive data exposure    |
| `/api/auth/*`                     | Cross-origin POST login credentials                               | **High** — credential harvesting      |
| `/api/webhooks/:id/rotate-secret` | Cross-origin POST to rotate webhook secrets                       | **High** — webhook hijacking          |
| `/api/disputes/*`                 | Cross-origin POST to manipulate dispute lifecycle                 | **Medium** — governance manipulation  |
| `/api/trust/*`, `/api/bond/*`     | Cross-origin GET to read trust/bond data                          | **Low** — read-only data exposure     |

---

## Default Policy

The baseline CORS policy is governed by the `CORS_ORIGIN` environment variable:

| Environment            | Default `CORS_ORIGIN`  | Behaviour                                                    |
| ---------------------- | ---------------------- | ------------------------------------------------------------ |
| `development` / `test` | `*`                    | All origins allowed (local development convenience)          |
| `production`           | Must be set explicitly | Wildcard (`*`) is **strictly blocked** at startup validation |

**Production requirement:** `CORS_ORIGIN` must be set to a single fully-qualified domain name or a comma-separated list of trusted origins.

```ini
# Single origin
CORS_ORIGIN=https://app.credence.io

# Multiple origins
CORS_ORIGIN=https://app.credence.io,https://admin.credence.io
```

> **Validation:** If `CORS_ORIGIN` is unset or set to `*` when `NODE_ENV=production`, the application prints a typed `ConfigValidationError` and exits with code 1. This prevents insecure deployments.

---

## Public Routes Quick Reference

Routes callable without user authentication or API keys, with their CORS classification:

| Route | Method(s) | CORS Policy | Allowed Origins (production) |
| ----- | --------- | ----------- | ---------------------------- |
| `/.well-known/jwks.json` | `GET` | **Open** | Any origin |
| `/api/health` and subpaths (`/live`, `/ready`, `/workers`, …) | `GET` | **Open** | Any origin |
| `/api/version` | `GET` | **Open** | Any origin |
| `/csp-report` | `POST` | **Open** | Any origin |
| `/api/reports/download/:key` | `GET` | **Open** | Any origin (signed URL is the credential) |
| `/api/bond/:address` | `GET` | **Restricted** | Origins listed in `CORS_ORIGIN` |
| `/api/verification/:address` | `GET` | **Restricted** | Origins listed in `CORS_ORIGIN` |
| `/api/verification/verify` | `POST` | **Restricted** | Origins listed in `CORS_ORIGIN` |

In `development` and `test`, **Restricted** routes accept any origin when `CORS_ORIGIN=*` (the default).

---

## Route Classification

Every route group is assigned one of three CORS policies:

| Policy               | Meaning                                                                            | Express Implementation                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Open**             | Any origin may make requests. No `Access-Control-Allow-Origin` restriction.        | Omit CORS middleware entirely, or use `cors({ origin: true })`                                                |
| **Restricted**       | Only origins listed in the `CORS_ORIGIN` allowlist (production) or `*` (dev/test). | Use `cors({ origin: corsOriginList })`                                                                        |
| **Same-origin only** | Only requests from the same origin (protocol + host + port) are allowed.           | Use `cors({ origin: false })` or omit `Access-Control-Allow-Origin` header; browser blocks cross-origin reads |

| Route Group                              | Method(s) | CORS Policy                                 | Authentication                  | Rationale                                                                                                                                                         |
| ---------------------------------------- | --------- | ------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/.well-known/jwks.json`                 | `GET`     | **Open**                                    | None                            | Public JWKS per RFC 8414 / OIDC Discovery. Intentionally unauthenticated and cross-origin accessible.                                                             |
| `/metrics`                               | `GET`     | **Restricted** (CIDR whitelist, no browser) | None (IP-restricted)            | Operational Prometheus metrics. Access is restricted via `METRICS_ALLOWED_CIDRS`, not CORS. Browsers are not expected to consume this endpoint.                   |
| `/api/health*`                           | `GET`     | **Open**                                    | None                            | Health/readiness/liveness probes called by orchestrators (K8s), monitoring dashboards, and load balancers from arbitrary origins. No sensitive data returned.     |
| `/api/version`                           | `GET`     | **Open**                                    | None                            | Version metadata (git SHA, build timestamp, Node version). No sensitive data returned.                                                                            |
| `/csp-report`                            | `POST`    | **Open**                                    | None                            | CSP violation reports POSTed by browsers from any origin. No sensitive data; used only for telemetry.                                                             |
| `/api/auth/login`                        | `POST`    | **Same-origin only**                        | None (credentials in body)      | Login credentials are sensitive. Must not be readable or accessible cross-origin to prevent credential harvesting.                                                |
| `/api/auth/refresh`                      | `POST`    | **Same-origin only**                        | Refresh token                   | Refresh tokens are bearer credentials. Same-origin only prevents token theft via cross-origin leaks.                                                              |
| `/api/trust/:address`                    | `GET`     | **Restricted**                              | API key (`trust:read`)          | Trust scores are public-readable but require authentication. CORS restriction follows the API key scope model.                                                    |
| `/api/bond/*`                            | `GET`     | **Restricted**                              | API key (`bond:read`)           | Bond status data. Authenticated read with API key.                                                                                                                |
| `/api/attestations/:address`             | `GET`     | **Restricted**                              | API key or user auth            | Attestation data. Authenticated read.                                                                                                                             |
| `/api/attestations/`                     | `POST`    | **Restricted**                              | API key or user auth            | Attestation creation. Authenticated write.                                                                                                                        |
| `/api/attestations/:id`                  | `DELETE`  | **Restricted**                              | API key or user auth            | Attestation revocation. Authenticated write.                                                                                                                      |
| `/api/bulk/verify`                       | `POST`    | **Restricted**                              | API key (`enterprise` scope)    | Batch verification. Enterprise API key required.                                                                                                                  |
| `/api/imports/*`                         | `POST`    | **Restricted**                              | API key                         | Data import. Authenticated write.                                                                                                                                 |
| `/api/reports`                           | `POST`    | **Restricted**                              | API key (`reports:generate`)    | Report generation job creation. Authenticated.                                                                                                                    |
| `/api/reports/:jobId`                    | `GET`     | **Restricted**                              | API key (`reports:generate`)    | Report status polling. Authenticated.                                                                                                                             |
| `/api/reports/top-talkers`               | `GET`     | **Restricted**                              | API key (`enterprise`)          | Top-talkers analytics. Authenticated.                                                                                                                             |
| `/api/reports/download/:key`             | `GET`     | **Open**                                    | Signed URL (cryptographic)      | Report artifact download uses signed URLs with HMAC-SHA256 verification. CORS is relaxed because the URL itself is the credential.                                |
| `/api/analytics/*`                       | `GET`     | **Restricted**                              | API key or user auth            | Analytics data. Authenticated read.                                                                                                                               |
| `/api/orgs/:orgId/policies/*`            | `*`       | **Restricted**                              | API key + RBAC                  | Tenant-scoped policy management. Authenticated.                                                                                                                   |
| `/api/payouts`                           | `POST`    | **Same-origin only**                        | API key (`payouts:write`)       | Payout/settlement creation. **Financial impact** — must not be triggerable cross-origin even with a valid API key.                                                |
| `/api/evidence/upload`                   | `POST`    | **Same-origin only**                        | User auth + admin role          | Encrypted evidence upload. Sensitive data and storage operations.                                                                                                 |
| `/api/evidence/:evidenceId`              | `GET`     | **Same-origin only**                        | User auth + RBAC                | Encrypted evidence retrieval. Sensitive data exposure.                                                                                                            |
| `/api/admin/*`                           | `*`       | **Same-origin only**                        | User auth + admin role          | **All admin operations** — role assignment, key revocation, impersonation, signing key rotation, cache purge, event replay, config reload. Full platform control. |
| `/api/webhooks/:webhookId/rotate-secret` | `POST`    | **Same-origin only**                        | User auth + admin role          | Webhook secret rotation. HMAC signing secret exposure could allow webhook impersonation.                                                                          |
| `/api/disputes/*`                        | `*`       | **Same-origin only**                        | User auth                       | Dispute lifecycle management (submit, review, resolve, dismiss). Governance data sensitivity.                                                                     |
| `/api/verification/:address`             | `GET`     | **Restricted**                              | None (public data)              | Verification proof generation. Returns signed data but no secrets.                                                                                                |
| `/api/verification/verify`               | `POST`    | **Restricted**                              | None (public data)              | Verification proof validation. Accepts public proofs.                                                                                                             |
| `/api/dev/fault-injection`               | `*`       | **Same-origin only**                        | Dev mode gate                   | Chaos engineering endpoint. Must never be reachable cross-origin. Only available when `DEV_MODE=true`.                                                            |
| `/api/ws/*`                              | WebSocket | **Restricted**                              | API key (query param or header) | WebSocket subscriptions for real-time score updates. API key validated at connection time.                                                                        |
| `/api/governance/*`                      | `*`       | **Same-origin only**                        | User auth                       | Governance actions (votes, proposals). Sensitive governance data.                                                                                                 |

---

## Implementation Guidance

### Current State

Per-route CORS middleware is enforced via `src/middleware/corsPolicy.ts` and mounted from `src/app.ts` using `applyRouteCorsPolicy()`. Startup validation rejects `CORS_ORIGIN=*` in production.

### Recommended Implementation

To enforce the per-route policy above, introduce the `cors` Express middleware package:

```typescript
import cors from "cors";

// ── Resolve allowed origins from configuration ──────────────────────────────
const parseCorsOrigins = (raw: string): string[] | false => {
  if (raw === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

// ── Middleware factories ────────────────────────────────────────────────────

/** Same-origin only — no cross-origin requests allowed. */
export const corsSameOrigin = cors({ origin: false });

/** Restricted to the configured CORS_ORIGIN allowlist. */
export const corsRestricted = (allowedOrigins: string) => {
  const origins = parseCorsOrigins(allowedOrigins);
  return cors({
    origin: origins === "*" ? true : origins,
    // Disallow credentials with wildcard origins
    credentials: origins !== "*",
  });
};

/** Open — any origin allowed. */
export const corsOpen = cors({ origin: true });
```

Then apply at the route level in `src/app.ts`:

```typescript
// Same-origin only: admin, payouts, evidence, auth, disputes, webhooks
app.use("/api/admin", corsSameOrigin);
app.use("/api/payouts", corsSameOrigin);
app.use("/api/evidence", corsSameOrigin);
app.use("/api/auth", corsSameOrigin);
app.use("/api/webhooks", corsSameOrigin);
app.use("/api/disputes", corsSameOrigin);
app.use("/api/dev", corsSameOrigin);
app.use("/api/governance", corsSameOrigin);

// Restricted: all authenticated data routes
const corsMiddleware = corsRestricted(config.cors.origin);
app.use("/api/trust", corsMiddleware);
app.use("/api/bond", corsMiddleware);
app.use("/api/attestations", corsMiddleware);
app.use("/api/bulk", corsMiddleware);
app.use("/api/imports", corsMiddleware);
app.use("/api/reports", corsMiddleware);
app.use("/api/analytics", corsMiddleware);
app.use("/api/orgs", corsMiddleware);
app.use("/api/verification", corsMiddleware);

// Open: health, version, JWKS, CSP reports
app.use("/api/health", corsOpen);
app.use("/api/version", corsOpen);
app.use("/.well-known", corsOpen);
app.use("/csp-report", corsOpen);

// Report downloads: open (signed URLs are the credential)
app.use("/api/reports/download", corsOpen);
```

### CORS and WebSocket

WebSocket connections are not subject to CORS in the same way as HTTP requests. The browser does not enforce same-origin policy on WebSocket upgrade requests. Instead, authentication is enforced at the application layer via API key validation in `src/routes/ws.ts`. The per-route CORS policy for `ws://` endpoints is documented above as **Restricted** for reference but is advisory — the effective security control is the API key check.

### CORS and Signed URLs

The `/api/reports/download/:key` endpoint is classified as **Open** because:

- Access is controlled by a signed URL (`key`, `expires`, `signature` query parameters)
- The HMAC-SHA256 signature cryptographically binds the URL to a specific resource and expiration time
- CORS relaxation is safe because the signature itself is the bearer credential
- Blocking cross-origin downloads would break legitimate embedding of report links in dashboards and portals

---

## Negative Test

A negative test should verify that cross-origin requests to same-origin-only endpoints are properly rejected. The test should fail **before** the CORS enforcement is implemented and pass **after**.

```typescript
// tests/routes/corsPolicy.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../app.js";

describe("CORS per-route policy enforcement", () => {
  it("rejects cross-origin POST to /api/admin/* with typed error", async () => {
    const res = await request(app)
      .post("/api/admin/users")
      .set("Origin", "https://evil.com")
      .set("Authorization", "Bearer <admin-token>");

    // Before fix: 200 with data (no CORS check)
    // After fix: 403 with typed CORS error
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("code", "cors_blocked");
  });

  it("allows same-origin GET to /api/health from any origin", async () => {
    const res = await request(app)
      .get("/api/health/live")
      .set("Origin", "https://any-origin.com");

    expect(res.status).toBe(200);
  });

  it("allows cross-origin GET to /api/reports/download/:key with valid signature", async () => {
    const res = await request(app)
      .get("/api/reports/download/test-key?expires=9999999999&signature=valid")
      .set("Origin", "https://dashboard.credence.io");

    // Signed URLs should be accessible cross-origin
    expect(res.status).not.toBe(403);
  });

  it("rejects cross-origin POST to /api/payouts/", async () => {
    const res = await request(app)
      .post("/api/payouts/")
      .set("Origin", "https://evil.com")
      .set("X-API-Key", "valid-key");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("code", "cors_blocked");
  });
});
```

The test uses a typed error code (`cors_blocked`) that should be added to the centralized error catalog in `src/lib/errorCatalog.ts`:

```typescript
CORS_BLOCKED: {
  code: 'cors_blocked',
  sdkClassName: 'CorsBlockedCredenceError',
  kind: 'api',
  httpStatus: 403,
  defaultMessage: 'Cross-origin request blocked by per-route CORS policy',
  category: 'authorization',
},
```

---

## Deployment Guidance

When deploying to production:

1. **Set `CORS_ORIGIN`** to the trusted origin(s) of your frontend application(s). This controls the **Restricted** route group.
2. **Verify same-origin-only routes** by testing cross-origin requests from a browser developer console or curl with an `Origin` header.
3. **Monitor `cors_blocked` errors** in your observability stack — unexpected blocked requests may indicate a misconfigured client or an attempted attack.
4. **Do not add origins to `CORS_ORIGIN`** that should only be accessed same-origin (admin, payouts, evidence). If a dashboard needs cross-origin access to admin endpoints, re-route through a trusted backend proxy instead.
5. **Signed download URLs** (`/api/reports/download/:key`) are intentionally **Open** — ensure your HMAC signing secret (`REPORT_STORAGE_SIGNING_SECRET`) is rotated regularly.

---

## Related Documents

| Document                                         | Covers                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| [`SECURITY.md`](SECURITY.md)                     | Global CORS origin policy, startup validation, wildcard prohibition |
| [`SECURITY_HEADERS.md`](SECURITY_HEADERS.md)     | Response headers including `Cross-Origin-Resource-Policy`           |
| [`API_ERROR_TAXONOMY.md`](API_ERROR_TAXONOMY.md) | Centralized error catalog including `cors_blocked` code             |
| [`CONFIG_TEMPLATE.md`](CONFIG_TEMPLATE.md)       | `CORS_ORIGIN` env var documentation                                 |
| [`SERVICE_ACCOUNTS.md`](SERVICE_ACCOUNTS.md)     | Service account permissions and threat model                        |
| [`architecture.md`](architecture.md)             | System architecture, API gateway, and deployment topology           |
| [`rate-limiting.md`](rate-limiting.md)           | Rate limiting as an additional defence layer                        |
| [`WEBHOOK_RECEIVE.md`](WEBHOOK_RECEIVE.md)       | Webhook receiving endpoint security                                 |
