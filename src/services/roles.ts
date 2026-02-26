import { ALL_ROLES, ROLE_HIERARCHY, Role } from '../types/rbac.ts'


/**
 * In-memory role store keyed by identity UUID.
 *
 * In production this would be backed by a `roles` DB table or a JWT claim.
 * The interface is kept thin so swapping the backing store requires only
 * this file.
 */
const roleStore = new Map<string, Role>()

// ---------------------------------------------------------------------------
// RoleService
// ---------------------------------------------------------------------------

/**
 * Manages role assignment and lookup for Credence identities.
 *
 * All methods are synchronous for simplicity; replace with async DB calls
 * when persisting roles to PostgreSQL.
 */
export class RoleService {
     /**
      * Returns the role assigned to `identityId`, defaulting to `'user'`
      * when no explicit assignment exists.
      */
     getRole(identityId: string): Role {
          return roleStore.get(identityId) ?? 'user'
     }

     /**
      * Assigns `role` to `identityId`.
      * Throws if `role` is not a recognised value.
      */
     assignRole(identityId: string, role: Role): void {
          if (!ALL_ROLES.includes(role)) {
               throw new Error(`Unknown role "${role}". Valid roles: ${ALL_ROLES.join(', ')}`)
          }
          roleStore.set(identityId, role)
     }

     /**
      * Removes any explicit role assignment for `identityId`.
      * Subsequent calls to `getRole` will return `'user'`.
      */
     revokeRole(identityId: string): void {
          roleStore.delete(identityId)
     }

     /**
      * Returns `true` when `candidate` has at least as much privilege as
      * `required`, using the ROLE_HIERARCHY numeric weights.
      */
     hasMinRole(candidate: Role, required: Role): boolean {
          return ROLE_HIERARCHY[candidate] >= ROLE_HIERARCHY[required]
     }

     /**
      * Returns `true` when `candidate` is exactly `required`.
      */
     hasExactRole(candidate: Role, required: Role): boolean {
          return candidate === required
     }

     /**
      * Clears all role assignments.
      * Intended for use in tests only.
      */
     _reset(): void {
          roleStore.clear()
     }
}

export const roleService = new RoleService()