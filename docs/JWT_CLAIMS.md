# Canonical JWT Claims Reference

> **Audience:** Contributors (engineers building API routes, authentication middleware, and background services in Credence Backend).

This document serves as the canonical reference for all JSON Web Token (JWT) headers and claims issued, signed, and consumed within the Credence Backend service.

---

## 1. Protected Header Claims

All JWTs issued by `KeyManager` (`src/services/keyManager/index.ts`) use RSASSA-PSS signature algorithms and include protected headers for public key discovery.

| Header | Type | Value / Format | Purpose | Producer | Consumer |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `alg` | `string` | `PS256` | Signature algorithm (RSASSA-PSS using SHA-256) | `KeyManager.signToken()` | `jose.jwtVerify()` |
| `kid` | `string` | UUID v4 (e.g. `9b1deb4d-3b7d-4b69-9cd...`) | Key Identifier matching active key in `/.well-known/jwks.json` | `KeyManager.signToken()` | `KeyManager.verifyToken()` |

### Protected Header Example

```json
{
  "alg": "PS256",
  "kid": "c8a32b6e-41d5-4e78-9b88-824f2b1d604e"
}
```

---

## 2. Standard Registered Claims (RFC 7519)

Standard claims ensure interoperability and enforce token expiration and clock tolerance.

| Claim | Name | Type | Description / Example | Default / Lifetime | Consumer |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `iss` | Issuer | `string` | Token issuer URL (`https://credence.org`) | Mandatory | `jwtVerify()` |
| `sub` | Subject | `string` | Principal identifier (e.g. `admin-user-1`) | User / Key ID | `requireUserAuth` |
| `aud` | Audience | `string` | Intended recipient service (`credence-api`) | `credence-api` | Token validator |
| `exp` | Expiration | `number` | Unix epoch seconds when token expires | $t_{\text{issued}} + 3600\text{s}$ (`1h`) | `jwtVerify()` |
| `nbf` | Not Before | `number` | Unix epoch seconds before which token is invalid | $t_{\text{issued}}$ | `jwtVerify()` |
| `iat` | Issued At | `number` | Unix epoch seconds when token was signed | Instant of signing | `jwtVerify()` |
| `jti` | JWT ID | `string` | Unique UUID v4 token identifier | Unique per token | Replay protection |

---

## 3. Credence Custom Claims

Credence embeds authorization, multi-tenancy, and role metadata into the JWT payload.

| Claim | Type | Description | Allowed Values | Consuming Middleware |
| :--- | :--- | :--- | :--- | :--- |
| `tenant_id` | `string` | Tenant isolation scope | `tenant-admin`, `tenant-verifier`, UUID | `runWithTenant()` / `tenantContext.ts` |
| `role` | `string` | User authorization role | `super-admin`, `admin`, `verifier`, `user` | `requireAdminRole` / `rbac.ts` |
| `scope` | `string[]` | Granted API permissions | `trust:read`, `attestations:write`, `payouts:write`, `reports:generate`, `exports:read`, `webhooks:admin`, `admin:write` | `requireApiKey` / `scopeSatisfies` |
| `impersonator` | `string` (optional) | Admin ID who initiated impersonation | Admin User ID | `ImpersonationService` / Audit log |
| `reason` | `string` (optional) | Audit reason for impersonation session | Non-empty string | Audit log |

### Complete JWT Payload Example

```json
{
  "iss": "https://credence.org",
  "sub": "user-4821",
  "aud": "credence-api",
  "exp": 1784958791,
  "nbf": 1784955191,
  "iat": 1784955191,
  "jti": "e9b5f3a0-1284-4821-b32d-304e28491821",
  "tenant_id": "tenant-verifier",
  "role": "verifier",
  "scope": [
    "trust:read",
    "attestations:read",
    "attestations:write"
  ]
}
```

---

## 4. Impersonation Session Claims

When an admin user issues a short-lived impersonation token (`src/services/impersonation/index.ts`), additional audit claims are embedded.

```json
{
  "iss": "https://credence.org",
  "sub": "target-user-99",
  "aud": "credence-api",
  "exp": 1784956091,
  "iat": 1784955191,
  "tenant_id": "tenant-admin",
  "role": "user",
  "impersonator": "admin-user-1",
  "reason": "Investigating dispute #402 regarding unverified bond settlement"
}
```

### Impersonation Rules & Limits
1. **Default Lifetime:** $900 \text{ seconds}$ ($15 \text{ minutes}$).
2. **Hard Ceiling:** Capped at $3,600 \text{ seconds}$ ($1 \text{ hour}$).
3. **No Nested Impersonation:** An impersonation token cannot be used to issue another impersonation token.

---

## 5. Token Producer & Consumer Matrix

```
[KeyManager / SignJWT] ──(signs PS256 token with kid)──> [HTTP Request Header]
                                                                  │
                                                                  ▼
[/.well-known/jwks.json] <──(fetches active/retired kid)─── [verifyToken / jwtVerify]
                                                                  │
                                                                  ▼
[AuthenticatedRequest] <──(attaches req.user & req.apiKey)─── [auth middleware]
```

### Key Lifecycle & Verification Rules
- **Active Signing Key:** Used for signing all new JWTs.
- **Retired Signing Key:** Maintained in JWKS during `gracePeriodSeconds` ($3600\text{s}$) to verify tokens issued prior to key rotation.
- **Clock Skew Tolerance:** `clockSkewSeconds` ($300\text{s}$) is added to `jwtVerify()` tolerance to accommodate server clock drift.

---

## 6. Verification Checklist for Contributors

When adding new JWT claims or modifying token validation:
- [ ] Register new claim names in this document (`docs/JWT_CLAIMS.md`).
- [ ] Use `snake_case` for custom claim keys (`tenant_id`, `impersonator`).
- [ ] Ensure any new request/response shape has a matching Zod schema and regenerated OpenAPI specification (`npm run generate:openapi`).
- [ ] Verify unit tests cover valid tokens, expired tokens (`exp`), missing `kid` headers, and unknown key IDs.
