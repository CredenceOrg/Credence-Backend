import type { Pool, PoolClient } from 'pg'
import type { CreateIdentityInput, Identity } from '../../types/index.ts'

/**
 * Error thrown when an identity address is already registered.
 *
 * Invariant: `create` must never silently overwrite an existing identity.
 * Callers can distinguish this deterministic, user-actionable failure from
 * transient database errors (connection loss, timeouts) which should be
 * retried.
 */
export class DuplicateIdentityError extends Error {
     readonly code = 'IDENTITY_DUPLICATE'
     constructor(readonly address: string) {
          super(`Identity already exists for address: ${address}`)
          this.name = 'DuplicateIdentityError'
     }
}

/**
 * Error thrown when an identity is not found for a mutation that requires it.
 */
export class IdentityNotFoundError extends Error {
     readonly code = 'IDENTITY_NOT_FOUND'
     constructor(readonly id: string) {
          super(`Identity not found: ${id}`)
          this.name = 'IdentityNotFoundError'
     }
}

/**
 * Error thrown when input fails validation before touching the database.
 */
export class IdentityValidationError extends Error {
     readonly code = 'IDENTITY_INVALID_INPUT'
     constructor(message: string) {
          super(message)
          this.name = 'IdentityValidationError'
     }
}

/**
 * Postgres unique-violation SQLSTATE.
 */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * Maximum number of rows a single `findAll` call may return. Prevents a
 * caller from accidentally requesting an unbounded scan.
 */
export const MAX_FIND_ALL_LIMIT = 1000

/**
 * Default page size for `findAll`.
 */
export const DEFAULT_FIND_ALL_LIMIT = 100

/**
 * Ethereum-style address: `0x` followed by 40 hex characters.
 * Kept intentionally strict so invalid input is rejected deterministically
 * before any database round-trip.
 */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

/**
 * UUID v1-v5 pattern used to validate surrogate ids before querying.
 */
const UUID_PATTERN =
     /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/

/**
 * Returns true when the supplied error is a Postgres unique-constraint
 * violation. Used to translate driver errors into a stable domain error so
 * callers do not depend on driver-specific shapes.
 */
function isUniqueViolation(err: unknown): boolean {
     return (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
     )
}

/**
 * Normalizes an address to lowercase so lookups and uniqueness checks are
 * case-insensitive. This is the canonical form stored in the database.
 */
function normalizeAddress(address: string): string {
     return address.toLowerCase()
}

/**
 * Validates and normalizes a create/upsert input.
 *
 * Invariants enforced here (before any I/O):
 *  - `address` is a non-empty string.
 *  - `address` matches the expected hex address shape.
 *  - The returned address is lowercased for deterministic storage/lookup.
 */
function validateAddress(address: unknown): string {
     if (typeof address !== 'string' || address.length === 0) {
          throw new IdentityValidationError('address must be a non-empty string')
     }
     if (!ADDRESS_PATTERN.test(address)) {
          throw new IdentityValidationError(
               'address must be a 0x-prefixed 40-character hex string',
          )
     }
     return normalizeAddress(address)
}

/**
 * Validates a surrogate UUID id before querying.
 */
function validateId(id: unknown): string {
     if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
          throw new IdentityValidationError('id must be a valid UUID')
     }
     return id
}

/**
 * Validates pagination arguments for `findAll`.
 *
 * Boundary rules:
 *  - `limit` must be an integer in [1, MAX_FIND_ALL_LIMIT].
 *  - `offset` must be an integer >= 0.
 * Non-integer or out-of-range values are rejected rather than silently
 * coerced, so callers cannot accidentally request an unbounded scan.
 */
function validatePagination(limit: unknown, offset: unknown): { limit: number; offset: number } {
     if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FIND_ALL_LIMIT) {
          throw new IdentityValidationError(
               `limit must be an integer between 1 and ${MAX_FIND_ALL_LIMIT}`,
          )
     }
     if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
          throw new IdentityValidationError('offset must be a non-negative integer')
     }
     return { limit, offset }
}

/**
 * Repository for identity records.
 *
 * Design notes / invariants:
 *  - All public methods validate their inputs before issuing SQL, so invalid
 *    input never reaches the database and never mutates state.
 *  - Addresses are stored and compared in lowercase canonical form.
 *  - `create` is strict: a duplicate address raises `DuplicateIdentityError`
 *    and never overwrites the existing row.
 *  - `upsert` is idempotent: repeated calls with the same address return the
 *    same row id and only refresh `updated_at`.
 *  - `delete` is idempotent: deleting a missing id returns `false` without
 *    throwing.
 *  - Read methods return `null` for missing rows rather than throwing.
 *  - Transient driver errors propagate unchanged so callers can retry; only
 *    deterministic, user-actionable failures are translated to domain errors.
 */
export class IdentityRepository {
     constructor(private readonly db: Pool | PoolClient) { }

     // -------------------------------------------------------------------------
     // Helpers
     // -------------------------------------------------------------------------

     /** Maps a raw postgres row (snake_case) to the Identity domain type. */
     private map(row: Record<string, unknown>): Identity {
          return {
               id: row.id as string,
               address: row.address as string,
               createdAt: row.created_at as Date,
               updatedAt: row.updated_at as Date,
          }
     }

     // -------------------------------------------------------------------------
     // Queries
     // -------------------------------------------------------------------------

     /**
      * Returns all identities ordered by creation date (newest first).
      * @param limit  Maximum rows to return (default 100).
      * @param offset Pagination offset (default 0).
      */
     async findAll(limit = DEFAULT_FIND_ALL_LIMIT, offset = 0): Promise<Identity[]> {
          const { limit: safeLimit, offset: safeOffset } = validatePagination(limit, offset)
          const { rows } = await this.db.query(
               `SELECT id, address, created_at, updated_at
         FROM identities
        ORDER BY created_at DESC, id ASC
        LIMIT $1 OFFSET $2`,
               [safeLimit, safeOffset],
          )
          return rows.map(this.map)
     }

     /**
      * Returns the identity with the given surrogate UUID, or `null` if not found.
      */
     async findById(id: string): Promise<Identity | null> {
          const safeId = validateId(id)
          const { rows } = await this.db.query(
               `SELECT id, address, created_at, updated_at
         FROM identities
        WHERE id = $1`,
               [safeId],
          )
          return rows.length ? this.map(rows[0]) : null
     }

     /**
      * Returns the identity for the given blockchain address, or `null`.
      */
     async findByAddress(address: string): Promise<Identity | null> {
          const safeAddress = validateAddress(address)
          const { rows } = await this.db.query(
               `SELECT id, address, created_at, updated_at
         FROM identities
        WHERE address = $1`,
               [safeAddress],
          )
          return rows.length ? this.map(rows[0]) : null
     }

     // -------------------------------------------------------------------------
     // Mutations
     // -------------------------------------------------------------------------

     /**
      * Inserts a new identity row and returns the created record.
      * Throws if `address` is already registered (unique constraint).
      */
     async create(input: CreateIdentityInput): Promise<Identity> {
          const address = validateAddress(input?.address)
          try {
               const { rows } = await this.db.query(
                    `INSERT INTO identities (address)
            VALUES ($1)
         RETURNING id, address, created_at, updated_at`,
                    [address],
               )
               return this.map(rows[0])
          } catch (err) {
               if (isUniqueViolation(err)) {
                    throw new DuplicateIdentityError(address)
               }
               throw err
          }
     }

     /**
      * Upserts an identity by address.
      * - If the address already exists, `updated_at` is refreshed and the
      *   existing row is returned.
      * - If it does not exist, a new row is inserted.
      */
     async upsert(input: CreateIdentityInput): Promise<Identity> {
          const address = validateAddress(input?.address)
          const { rows } = await this.db.query(
               `INSERT INTO identities (address)
            VALUES ($1)
       ON CONFLICT (address)
       DO UPDATE SET updated_at = NOW()
         RETURNING id, address, created_at, updated_at`,
               [address],
          )
          return this.map(rows[0])
     }

     /**
      * Hard-deletes the identity with the given UUID.
      * Cascades to all associated bonds (ON DELETE CASCADE).
      * Returns `true` if a row was deleted, `false` if not found.
      */
     async delete(id: string): Promise<boolean> {
          const safeId = validateId(id)
          const { rowCount } = await this.db.query(
               `DELETE FROM identities WHERE id = $1`,
               [safeId],
          )
          return (rowCount ?? 0) > 0
     }
}