# RBAC – Role-Based Access Control

## Roles

| Role | Hierarchy | Description |
|---|---|---|
| `public` | 0 | Unauthenticated / anonymous caller |
| `user` | 1 | Standard authenticated participant (default) |
| `verifier` | 2 | Can read trust/bond data and trigger verifications |
| `admin` | 3 | Full platform access, can assign roles |

Roles are hierarchical: a higher-ranked role always satisfies a lower-ranked requirement.

---

## Middleware

All three factories live in `src/middleware/rbac.ts`.

### `requireRole(...roles)`

Allows only callers whose role is **exactly one of** the listed roles.

```ts
import { requireRole } from './middleware/rbac'

router.post('/admin/slash',     requireRole('admin'),             handler)
router.get('/verify/:address',  requireRole('admin', 'verifier'), handler)
```

### `requireMinRole(minRole)`

Allows callers whose role is **at least as privileged** as `minRole`.

```ts
router.get('/bonds', requireMinRole('verifier'), handler) // verifier + admin
router.get('/me',    requireMinRole('user'),     handler) // user + verifier + admin
```

### `requireAnyRole()`

Allows **any authenticated** caller (blocks only requests with no `req.user`).

```ts
router.get('/profile', requireAnyRole(), handler)
```

---

## RoleService

`src/services/roles.ts` manages role assignment and lookup.

```ts
import { roleService } from './services/roles'

roleService.assignRole(identityId, 'verifier')   // assign
roleService.getRole(identityId)                  // → 'verifier'
roleService.revokeRole(identityId)               // → back to 'user' default
roleService.hasMinRole('admin', 'verifier')      // → true
roleService.hasExactRole('admin', 'verifier')    // → false
```

Unknown identities default to `'user'`.

---

## Access Denial Logging

Every denied request emits a structured JSON log line to `console.warn`:

```json
{
  "event": "access_denied",
  "method": "POST",
  "path": "/admin/slash",
  "reason": "role \"user\" not in [admin]",
  "userId": "abc-123",
  "userRole": "user",
  "userAddress": "0xABC",
  "timestamp": "2026-02-25T10:00:00.000Z"
}
```

---

## Route Protection Reference

| Route | Method | Required Role |
|---|---|---|
| `/api/health` | GET | public |
| `/api/trust/:address` | GET | `requireMinRole('user')` |
| `/api/bond/:address` | GET | `requireMinRole('verifier')` |
| `/api/identity` | POST | `requireMinRole('user')` |
| `/api/admin/*` | ALL | `requireRole('admin')` |