/**
 * @file src/services/members/errors.ts
 *
 * Typed sentinel error classes for the member service. Using named classes
 * instead of substring-matching on `err.message` makes the route layer's
 * status-code mapping robust to wording changes and gives the test layer
 * an explicit structure to assert against.
 *
 * The error name is preserved on the prototype so `err.name === '<ClassName>'`
 * is still meaningful for log scrapers that don't preserve class identity.
 */

/** Member row already exists in active state for (org_id, user_id). → 409 */
export class MemberAlreadyActiveError extends Error {
  constructor(message = 'Member is already active in this organisation') {
    super(message)
    this.name = 'MemberAlreadyActiveError'
  }
}

/** Member does not exist OR belongs to a different org than the caller's URL. → 404 */
export class MemberNotFoundError extends Error {
  constructor(message = 'Member not found') {
    super(message)
    this.name = 'MemberNotFoundError'
  }
}

/** Member has already been soft-deleted and is no longer active. → 404 */
export class MemberAlreadyDeletedError extends Error {
  constructor(message = 'Member not found or already deleted') {
    super(message)
    this.name = 'MemberAlreadyDeletedError'
  }
}

/**
 * Last-owner guard: refusing to demote or delete the last active owner
 * of an organisation. → 409.
 *
 * Both DELETE and PATCH routes classify this to HTTP 409 so callers
 * know the failure is recoverable by minting another owner.
 */
export class LastOwnerError extends Error {
  constructor(message = 'Cannot mutate the last active owner of the organisation') {
    super(message)
    this.name = 'LastOwnerError'
  }
}

/** Restore blocked by an active dual membership for the same user. → 409 */
export class ActiveMembershipExistsError extends Error {
  constructor(
    message = 'Cannot restore: an active membership already exists for this user in this organisation',
  ) {
    super(message)
    this.name = 'ActiveMembershipExistsError'
  }
}
