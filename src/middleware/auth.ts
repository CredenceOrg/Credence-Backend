import { Request, Response, NextFunction } from "express";
import type { StoredApiKey, KeyScope } from "../services/apiKeys.js";
import { validateApiKey } from "../services/apiKeys.js";
import { authConcurrencyGuard } from "../auth/concurrency.js";
import { userRepo } from "../repositories/userRepository.js";
import { runWithTenant } from "../utils/tenantContext.js";

/**
 * Granular API key scopes for per-endpoint authorization.
 *
 * Scope semantics
 * ───────────────
 * trust:read        – Read-only access to trust scores and bond data
 * attestations:read – Read attestations (list, count)
 * attestations:write – Create or revoke attestations
 * payouts:write     – Initiate payout / settlement operations
 * reports:generate  – Trigger and poll report generation jobs
 * exports:read      – Download report artifacts and audit-log exports
 * webhooks:admin    – Manage webhook signing secrets (rotate / revoke)
 * outbox:reinject   – Reinsert fixed quarantined outbox events
 * admin:read        – Read admin resources (users, audit logs, failed events)
 * admin:write       – Mutate admin resources (assign roles, revoke keys, replay events, impersonate)
 *
 * Backward-compat aliases
 * ───────────────────────
 * PUBLIC     – alias kept for existing callers; grants trust:read + attestations:read
 * ENTERPRISE – alias kept for existing callers; grants all scopes
 */
export enum ApiScope {
  // Granular scopes
  TRUST_READ = 'trust:read',
  ATTESTATIONS_READ = 'attestations:read',
  ATTESTATIONS_WRITE = 'attestations:write',
  PAYOUTS_WRITE = 'payouts:write',
  REPORTS_GENERATE = 'reports:generate',
  EXPORTS_READ = 'exports:read',
  WEBHOOKS_ADMIN = 'webhooks:admin',
  OUTBOX_REINJECT = 'outbox:reinject',
  ADMIN_READ = 'admin:read',
  ADMIN_WRITE = 'admin:write',
  FLAGS_READ = 'flags:read',
  FLAGS_WRITE = 'flags:write',
  BOND_READ = 'bond:read',
  BOND_WRITE = 'bond:write',

  // Legacy aliases (backward-compatible)
  PUBLIC = "public",
  ENTERPRISE = "enterprise",
}

/**
 * Scope sets granted by each legacy tier.
 * An ENTERPRISE key implicitly holds every granular scope.
 * A PUBLIC key holds the read-only subset.
 */
export const SCOPE_SETS: Record<string, ReadonlySet<ApiScope>> = {
  [ApiScope.PUBLIC]: new Set([ApiScope.TRUST_READ, ApiScope.ATTESTATIONS_READ]),
  [ApiScope.ENTERPRISE]: new Set([
    ApiScope.TRUST_READ,
    ApiScope.ATTESTATIONS_READ,
    ApiScope.ATTESTATIONS_WRITE,
    ApiScope.PAYOUTS_WRITE,
    ApiScope.REPORTS_GENERATE,
    ApiScope.EXPORTS_READ,
    ApiScope.WEBHOOKS_ADMIN,
    ApiScope.OUTBOX_REINJECT,
    ApiScope.ADMIN_READ,
    ApiScope.ADMIN_WRITE,
    ApiScope.FLAGS_READ,
    ApiScope.FLAGS_WRITE,
    ApiScope.BOND_READ,
    ApiScope.BOND_WRITE,
  ]),
};

/**
 * Return true when the granted scope set satisfies the required scope.
 *
 * Rules (in order):
 * 1. If grantedScopes contains the requiredScope directly → allow.
 * 2. If grantedScopes contains ENTERPRISE → allow (superset).
 * 3. If requiredScope is PUBLIC or TRUST_READ and grantedScopes contains PUBLIC → allow.
 * 4. Otherwise → deny.
 */
export function scopeSatisfies(
  grantedScopes: ReadonlySet<ApiScope> | ApiScope[],
  requiredScope: ApiScope,
): boolean {
  const scopes: ReadonlySet<ApiScope> = Array.isArray(grantedScopes)
    ? new Set(grantedScopes)
    : grantedScopes;

  // Direct match
  if (scopes.has(requiredScope)) return true;

  // ENTERPRISE is a superset of everything
  if (scopes.has(ApiScope.ENTERPRISE)) return true;

  // Expand legacy scope sets and re-check
  for (const legacyScope of [ApiScope.PUBLIC, ApiScope.ENTERPRISE]) {
    if (scopes.has(legacyScope)) {
      const expanded = SCOPE_SETS[legacyScope];
      if (expanded?.has(requiredScope)) return true;
    }
  }

  return false;
}

/**
 * User roles for role-based access control
 */
export enum UserRole {
  SUPER_ADMIN = "super-admin",
  ADMIN = "admin",
  VERIFIER = "verifier",
  USER = "user",
}

/**
 * Extended Express Request with API key and user metadata
 */
export interface AuthenticatedRequest extends Request {
  apiKey?: StoredApiKey;
  user?: {
    id: string;
    role: UserRole;
    email: string;
    tenantId: string;
  };
}

// ── Hardcoded mock stores removed ───────────────────────────────────────
// API_KEYS, MOCK_USERS, and API_KEY_TO_USER have been replaced by the
// persistent, hashed key store in src/services/apiKeys.ts.
// Test fixtures should use generateApiKey() to seed keys into the
// in-memory or database store.

/**
 * Map DB-stored scope strings to ApiScope enum values.
 * 'full' / 'enterprise' → ENTERPRISE (superset of all).
 * 'read' / 'public' → PUBLIC (read-only subset).
 * Granular scope strings (e.g. 'trust:read') pass through as-is.
 */
function mapDbScopesToApiScopes(dbScopes: string[]): ApiScope[] {
  return dbScopes.map((s): ApiScope => {
    if (s === 'full' || s === 'enterprise') return ApiScope.ENTERPRISE
    if (s === 'read' || s === 'public') return ApiScope.PUBLIC
    return s as ApiScope
  })
}

/**
 * Middleware to validate API key and enforce a required scope.
 *
 * Key lookup is performed exclusively against the hashed database store
 * via `validateApiKey`. Keys are never compared in plaintext and raw key
 * values are never logged.
 *
 * ## Concurrency and race safety
 *
 * Concurrent requests presenting the **same API key** are coalesced by the
 * `AuthConcurrencyGuard` singleton so that only one hash-comparison + store
 * look-up executes at a time.  All concurrent callers share the result.
 *
 * If a key's scopes are observed to change between two consecutive look-up
 * bursts (i.e. a scope change races an in-flight validation), the middleware
 * returns **409 Conflict** with a `Retry-After` header.  The client MUST
 * retry the request after waiting the advertised number of seconds; the key
 * itself remains valid.
 *
 * If the auth service is temporarily overloaded (too many concurrent in-flight
 * look-ups), the middleware returns **503 Service Unavailable** with a
 * `Retry-After` header.
 *
 * ## Client retry contract
 * | Status | Meaning                              | Client action                          |
 * |--------|--------------------------------------|----------------------------------------|
 * | 401    | Missing or invalid key               | Do not retry with the same key         |
 * | 403    | Valid key but insufficient scope     | Do not retry; acquire the required scope |
 * | 409    | Scope snapshot stale (concurrent change) | Retry after `Retry-After` seconds  |
 * | 503    | Auth service temporarily overloaded  | Retry after `Retry-After` seconds      |
 *
 * The middleware:
 * 1. Reads the key from `X-API-Key` or `Authorization: Bearer` headers.
 * 2. Passes the key through `AuthConcurrencyGuard.validate` (which calls
 *    `validateApiKey` under a per-key singleflight lock).
 * 3. Maps stored scope strings to `ApiScope` enum values.
 * 4. Calls `scopeSatisfies` to check whether the granted scopes cover the
 *    required scope — including legacy ENTERPRISE superset expansion.
 * 5. Attaches the full `StoredApiKey` record to `req.apiKey`.
 *
 * @param requiredScope - The single scope that must be satisfied.
 *
 * @example
 * ```typescript
 * router.post('/api/attestations', requireApiKey(ApiScope.ATTESTATIONS_WRITE), handler)
 * router.get('/api/trust/:id',     requireApiKey(ApiScope.TRUST_READ),          handler)
 * ```
 */
export function requireApiKey(requiredScope: ApiScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Accept key from X-API-Key header or Authorization: Bearer <key>
    let rawKey = req.headers["x-api-key"] as string | undefined;
    if (!rawKey) {
      const authHeader = req.headers["authorization"];
      if (authHeader?.startsWith("Bearer ")) {
        rawKey = authHeader.slice(7);
      }
    }

    if (!rawKey) {
      res.status(401).json({
        error: "Unauthorized",
        message: "API key is required",
      });
      return;
    }

    // Validate via the concurrency guard.
    // This coalesces concurrent look-ups for the same key and detects scope
    // conflicts that race in-flight validations.
    const result = await authConcurrencyGuard.validate(rawKey, validateApiKey);

    if (!result.ok) {
      if (result.retryAfter !== undefined) {
        res.set("Retry-After", String(result.retryAfter));
      }

      if (result.status === 409) {
        res.status(409).json({
          error: "Conflict",
          message: result.error,
          retryAfter: result.retryAfter,
        });
      } else if (result.status === 503) {
        res.status(503).json({
          error: "Service Unavailable",
          message: result.error,
          retryAfter: result.retryAfter,
        });
      } else {
        // 401
        res.status(401).json({
          error: "Unauthorized",
          message: "Invalid API key",
        });
      }
      return;
    }

    const dbKey: StoredApiKey = result.key;
    const grantedScopes = mapDbScopesToApiScopes(dbKey.scopes);

    // Deny-by-default: key must satisfy the required scope
    if (!scopeSatisfies(grantedScopes, requiredScope)) {
      if (requiredScope === ApiScope.ENTERPRISE) {
        res.status(403).json({
          error: 'Forbidden',
          message: 'Enterprise API key required',
        });
      } else {
        res.status(403).json({
          error: 'Forbidden',
          message: `Insufficient scope: '${requiredScope}' is required`,
          requiredScope,
          grantedScopes,
        });
      }
      return;
    }

    // Attach the full database record to the request for downstream handlers.
    (req as AuthenticatedRequest).apiKey = dbKey;
    next();
  };
}

/**
 * Middleware to check if user has admin role
 * Should be used after user authentication is established
 *
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * app.post('/api/admin/users', requireAdminRole, handler)
 * ```
 */
export function requireAdminRole(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authReq = req as AuthenticatedRequest;

  if (!authReq.user) {
    res.status(401).json({
      error: "Unauthorized",
      message: "User authentication required",
    });
    return;
  }

  if (
    authReq.user.role !== UserRole.ADMIN &&
    authReq.user.role !== UserRole.SUPER_ADMIN
  ) {
    res.status(403).json({
      error: "Forbidden",
      message: "Admin role required",
    });
    return;
  }

  next();
}

/**
 * Middleware to authenticate user from Authorization header (Bearer token format)
 * Should be used before requireAdminRole
 *
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * app.use('/api/admin', requireUserAuth, requireAdminRole, adminRouter)
 * ```
 */
export async function requireUserAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authReq = req as AuthenticatedRequest;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Bearer token required",
    });
    return;
  }

  const raw = authHeader.substring(7); // Remove 'Bearer ' prefix

  // Validate via the concurrency guard (coalesces concurrent look-ups for the
  // same token and detects scope conflicts that race in-flight validations).
  const result = await authConcurrencyGuard.validate(raw, validateApiKey);

  if (!result.ok) {
    if (result.retryAfter !== undefined) {
      res.set("Retry-After", String(result.retryAfter));
    }

    if (result.status === 409) {
      res.status(409).json({
        error: "Conflict",
        message: result.error,
        retryAfter: result.retryAfter,
      });
    } else if (result.status === 503) {
      res.status(503).json({
        error: "Service Unavailable",
        message: result.error,
        retryAfter: result.retryAfter,
      });
    } else {
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid or expired token",
      });
    }
    return;
  }

  const key = result.key;

  // Resolve the user record from the database via the key's owner.
  const user = userRepo.findById(key.ownerId);

  if (!user) {
    res.status(401).json({
      error: "Unauthorized",
      message: "User not found for this key",
    });
    return;
  }

  authReq.apiKey = key;
  authReq.user = {
    id: user.id,
    role: user.role as UserRole,
    email: user.email,
    tenantId: user.tenantId,
  };
  // Run the remainder of the request handling within the tenant async context
  runWithTenant(authReq.user.tenantId, () => next());
}
