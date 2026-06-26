import { Request, Response, NextFunction } from "express";
import type { StoredApiKey } from "../services/apiKeys.js";
import { validateApiKey } from "../services/apiKeys.js";
import { userRepo } from "../repositories/userRepository.js";
import { requireApiKey as requireApiKeyFromApiKeyMiddleware } from "./apiKey.js";
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

/**
 * Mock API key store — maps raw key → set of granted scopes.
 *
 * In production this is replaced by a database lookup via ApiKeyRepository.
 * The legacy single-scope values (PUBLIC / ENTERPRISE) are preserved here so
 * that existing test fixtures continue to work without modification.
 */
const API_KEYS: Record<string, ApiScope[]> = {
  // Legacy keys — kept for backward compatibility
  "test-enterprise-key-12345": [ApiScope.ENTERPRISE],
  "test-public-key-67890": [ApiScope.PUBLIC],

  // Granular-scope test keys (used in auth.scopes.test.ts)
  'test-trust-read-key': [ApiScope.TRUST_READ],
  'test-attestations-write-key': [ApiScope.ATTESTATIONS_READ, ApiScope.ATTESTATIONS_WRITE],
  'test-payouts-write-key': [ApiScope.PAYOUTS_WRITE],
  'test-reports-key': [ApiScope.REPORTS_GENERATE, ApiScope.EXPORTS_READ],
  'test-webhooks-admin-key': [ApiScope.WEBHOOKS_ADMIN],
  'test-outbox-reinject-key': [ApiScope.OUTBOX_REINJECT],
  'test-admin-read-key': [ApiScope.ADMIN_READ],
  'test-admin-write-key': [ApiScope.ADMIN_READ, ApiScope.ADMIN_WRITE],
  'test-flags-read-key': [ApiScope.FLAGS_READ],
  'test-flags-write-key': [ApiScope.FLAGS_READ, ApiScope.FLAGS_WRITE],
}

/**
 * Mock user store - in production, use database or identity provider
 * Format: { userId: { id, role, email, apiKey } }
 */
export const MOCK_USERS: Record<
  string,
  {
    id: string;
    role: UserRole;
    email: string;
    apiKey: string;
    tenantId: string;
  }
> = {
  "admin-user-1": {
    id: "admin-user-1",
    role: UserRole.SUPER_ADMIN,
    email: "admin@credence.org",
    apiKey: "admin-key-12345",
    tenantId: "tenant-admin",
  },
  "verifier-user-1": {
    id: "verifier-user-1",
    role: UserRole.VERIFIER,
    email: "verifier@credence.org",
    apiKey: "verifier-key-67890",
    tenantId: "tenant-verifier",
  },
};

/**
 * Mock API key to user mapping - in production, use database
 */
export const API_KEY_TO_USER: Record<string, string> = {
  "admin-key-12345": "admin-user-1",
  "verifier-key-67890": "verifier-user-1",
};

/**
 * Middleware to validate API key and enforce a required scope.
 *
 * The middleware:
 * 1. Reads the key from `X-API-Key` or `Authorization: Bearer` headers.
 * 2. Looks up the granted scope set (deny-by-default when key is unknown).
 * 3. Calls `scopeSatisfies` to check whether the granted scopes cover the
 *    required scope — including legacy ENTERPRISE superset expansion.
 * 4. Attaches `{ key, scopes }` to `req.apiKey` for downstream handlers.
 *
 * @param requiredScope - The single scope that must be satisfied.
 *
 * @example
 * ```typescript
 * router.post('/api/attestations', requireApiKey(ApiScope.ATTESTATIONS_WRITE), handler)
 * router.get('/api/trust/:id',     requireApiKey(ApiScope.TRUST_READ),          handler)
 * ```
 */
/**
 * Adapter to the canonical `requireApiKey` implemented in `src/middleware/apiKey.ts`.
 * Keeps the old `ApiScope` enum surface but delegates validation to the
 * DB-backed key validator. Mapping of scopes is performed below.
 */
export function requireApiKey(requiredScope: ApiScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Accept key from X-API-Key header or Authorization: Bearer <key>
    let apiKey = req.headers["x-api-key"] as string | undefined;
    if (!apiKey) {
      const authHeader = req.headers["authorization"];
      if (authHeader?.startsWith("Bearer ")) {
        apiKey = authHeader.slice(7);
      }
    }

    if (!apiKey) {
      res.status(401).json({
        error: "Unauthorized",
        message: "API key is required",
      });
      return;
    }

    let grantedScopes = API_KEYS[apiKey]
    let dbKey: StoredApiKey | null = null

    if (!grantedScopes) {
      dbKey = validateApiKey(apiKey)
      if (dbKey) {
        grantedScopes = dbKey.scopes.map((s): ApiScope => {
          if (s === 'full') return ApiScope.ENTERPRISE
          if (s === 'read') return ApiScope.PUBLIC
          return s as ApiScope
        })
      }
    }

    if (!grantedScopes) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid API key",
      });
      return;
    }

    // Deny-by-default: key must satisfy the required scope
    if (!scopeSatisfies(grantedScopes, requiredScope)) {
      if (requiredScope === ApiScope.ENTERPRISE) {
        res.status(403).json({
          error: 'Forbidden',
          message: 'Enterprise API key required',
        })
      } else {
        res.status(403).json({
          error: 'Forbidden',
          message: `Insufficient scope: '${requiredScope}' is required`,
          requiredScope,
          grantedScopes,
        })
      }
      return
    }

    // Attach metadata to request for downstream handlers.
    if (dbKey) {
      ;(req as any).apiKey = dbKey
    } else {
      ;(req as any).apiKey = {
        key: apiKey,
        scopes: grantedScopes,
        scope: grantedScopes.includes(ApiScope.ENTERPRISE)
          ? ApiScope.ENTERPRISE
          : grantedScopes[0],
      }
    }
    next()
  }
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
export function requireUserAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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

  const key = validateApiKey(raw);
  if (!key) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
    return;
  }

  // Resolve the user record from the repository. Tests and runtime should
  // seed `userRepo` with the expected records. If not found, treat as
  // unauthorized rather than silently creating a user.
  const user = userRepo.findById(key.ownerId);
  if (!user) {
    res.status(401).json({
      error: "Unauthorized",
      message: "User not found",
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
