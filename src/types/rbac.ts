
/**
 * All roles recognised by the Credence protocol.
 *
 * - `admin`    – full platform access, can assign roles
 * - `verifier` – can read trust/bond data and trigger verifications
 * - `user`     – standard authenticated participant
 * - `public`   – unauthenticated / anonymous caller
 */
export type Role = 'admin' | 'verifier' | 'user' | 'public'

/**
 * Hierarchy weight per role.
 * Higher value = more privileged.
 * Used so `requireMinRole` can do a single numeric comparison.
 */
export const ROLE_HIERARCHY: Record<Role, number> = {
     public: 0,
     user: 1,
     verifier: 2,
     admin: 3,
}

/** All valid role strings as a runtime array (useful for validation). */
export const ALL_ROLES: Role[] = ['admin', 'verifier', 'user', 'public']

/**
 * Minimal caller context attached to `req.user` by auth middleware
 * (or a stub in tests).
 */
export interface AuthenticatedUser {
     /** Surrogate identity UUID. */
     id: string
     /** Blockchain wallet address. */
     address: string
     /** Assigned role. */
     role: Role
}

/** Extends Express Request with the resolved caller. */
export interface AuthenticatedRequest extends Express.Request {
     user?: AuthenticatedUser
}