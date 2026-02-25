# JWT Authentication

This API gateway uses JWT bearer authentication for protected endpoints.

## Overview

- Access tokens are required on protected routes.
- Refresh tokens are used to issue new token pairs.
- Tokens are signed with HMAC SHA-256 (`HS256`).
- Claims validated on every request: `iss`, `sub`, `exp`.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `JWT_ISSUER` | Expected issuer claim (`iss`) | `credence-api` |
| `JWT_ACCESS_TOKEN_SECRET` | HMAC secret for access tokens | `dev-access-secret-change-me` |
| `JWT_REFRESH_TOKEN_SECRET` | HMAC secret for refresh tokens | `dev-refresh-secret-change-me` |
| `JWT_ACCESS_TOKEN_EXPIRY` | Access token lifetime (`s`, `m`, `h`, `d`) | `15m` |
| `JWT_REFRESH_TOKEN_EXPIRY` | Refresh token lifetime (`s`, `m`, `h`, `d`) | `7d` |
| `JWT_CLOCK_TOLERANCE_SECONDS` | Optional skew tolerance for expiry checks | `0` |

## Protected Request Format

Send access token in the `Authorization` header:

```http
Authorization: Bearer <access-token>
```

If missing/invalid/expired, the API returns:

```json
{
  "error": "Unauthorized",
  "message": "<reason>"
}
```

## Service API

JWT logic lives in:

- `src/services/auth.ts`
- `src/middleware/auth.ts`

### Issue Tokens

```ts
const auth = new AuthService()
const { accessToken, refreshToken } = auth.issueTokenPair('user-123')
```

### Validate Access Token

```ts
const claims = auth.verifyAccessToken(accessToken)
// claims: { iss, sub, exp, iat, type }
```

### Refresh Flow

```ts
const nextPair = auth.refreshToken(refreshToken)
```

`refreshToken()` validates the refresh token and returns a fresh access + refresh token pair.

## Express Middleware

Use JWT middleware for protected routes:

```ts
import { requireJwtAuth } from '../middleware/auth.js'

router.post('/secure-endpoint', requireJwtAuth(), handler)
```

Validated claims are attached to `req.auth`.

## Testing

Authentication tests:

- `src/services/auth.test.ts` (issue, verify, expiry, invalid tokens, refresh flow)
- `src/__tests__/auth.test.ts` (Express middleware behavior)
- `src/__tests__/bulk.test.ts` (protected endpoint integration)
