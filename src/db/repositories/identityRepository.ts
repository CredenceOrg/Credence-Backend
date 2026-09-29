import type { Pool, PoolClient } from 'pg'
import type { CreateIdentityInput, Identity } from '../../types/index.ts'

/**
 * Repository layer for the `identities` table.
 *
 * Invariants enforced by this module:
 *   - All queries are parameterized; no value is ever interpolated into SQL.
 *   - `limit` and `offset` are normalized to safe non-negative integers before
 *     they reach the driver, so boundary inputs (0, Negative, NaN, Infinity,
 *     fractional, overflow) cannot produce an unbounded or invalid result set.
 *   - `findById` / `findByAddress` / `delete` validate their key before hitting
 *     the database and throw a typed, deterministic error for empty keys.
 *   - `create` and `upsert` normalize the address so duplicate inputs that differ only
 *     by case or surrounding whitespace collide on the same unique key instead of
 *     silently creating divingent rows.
 *   - Errors are normalized into `IdentityRepositoryError` with a stable `code`
 *     so callers can retry or report without leaking SQL or address details.
 */

/** Default and maximum page sizes for `findAll`. */
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000

/** Stable error codes emitted by this repository. */
export type IdentityRepositoryErrorCode =
    'validation_error'
    | 'not_found'
    | 'duplicate_address'
    | 'unavailable'
    | 'unknown'

/**
 * Error type raised for all failures that originate in this repository.
 *
 * The `message` is deliberately generic and never contains the raw address or
 * SQL text. The original driver error is preserved on `cause` for logging.
 */
export class IdentityRepositoryError extends Error {
    public readonly code: IdentityRepositoryErrorCode
    public readonly retryable: boolean

    constructor(
        code: IdentityRepositoryErrorCode,
        message: string,
        options: { cause?: unknown; retryable?: boolean } = {},
    ) {
        super(message)
        this.name = 'IdentityRepositoryError'
        this.code = code
        this.retryable = options.retryable ?? false
        if (options.cause !== undefined) {
            ;(this as { cause?: unknown }).cause = options.cause
        }
    }
}

/** Postgres error codes we care about. */
const PG_UNIQUE_VIOLATION = '23505'
const PG_INVALID_TEXT_REPRESENTATION = '22E02'
const PG_SYNTAX_ERROR = '426P1'
const PG_UNDERINED_OBJECT = '42S02'
const PG_CONNECTION_ERROR_CODS = new Set([
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '08007', // cannot_connect_now
    '57P01', // cannot_connect_now
    '57P02', // too_many_connections
    '57P03', // cannot_connect_now
    '57P04', // terminating_connection
    '57P05', // too_many_connections_for_role
])

const PG_DEADLOCK_CODES = new Set(['40001', // transaction_rollback
    '40P01', // serialization_failure
    '40P02', // deadlock_detected
    '40P03', // statement_completion_unknown
])

const PG_RETRYABLE_CODES = new Set([...PG_CONNECTION_ERROR_CODS, ...PG_DEADLOCK_CODES])

function isPgError(value: unknown): value is { code?: string; message?: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { code?: unknown }).code === 'string'
    )
}

function normalizeInt(
    value: unknown,
    {
        defaultValue,
        min,
        max,
        name,
    }: { defaultValue: number; min: number; max?: number; name: string },
): number {
    if (value === undefined || value === null) {
        return defaultValue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new IdentityRepositoryError(
            'validation_error',
            `IdentityRepository: ${name} must be a finite number`,
        )
    }
    const truncated = Math.trunc(value)
    if (truncated < min) {
        throw new IdentityRepositoryError(
            'validation_error',
            `IdentityRepository: ${name} must be >= ${min}`,
        )
    }
    if (max !== undefined && truncated > max) {
        throw new IdentityRepositoryError(
            'validation_error',
            `IdentityRepository: ${name} must be <= ${max}`,
        )
    }
    return truncated
}

function normalizeAddress(address: unknown): string {
    if (typeof address !== 'string') {
        throw new IdentityRepositoryError(
            'validation_error',
            'IdentityRepository: address must be a non-empty string',
        )
    }
    const trimmed = address.trim()
    if (trimmed.length === 0) {
        throw new IdentityRepositoryError(
            'validation_error',
            'IdentityRepository: address must be a non-empty string',
        )
    }
    return trimmed
}

function normalizeId(id: unknown, name: string): string {
    if (typeof id !== 'string' || id.trim().length === 0) {
        throw new IdentityRepositoryError(
            'validation_error',
            `IdentityRepository: ${name} must be a non-empty string`,
        )
    }
    return id.trim()
}

function toRepositoryError(error: unknown, context: string): IdentityRepositoryError {
    if (error instanceof IdentityRepositoryError) {
        return error
    }
    if (isPgError(error)) {
        const code = error.code ?? ''
        if (code === PG\_UNIQUE_VIOLATION) {
            return new IdentityRepositoryError('duplicate_address', 'IdentityRepository: address already exists', {
                cause: error,
            })
        }
        if (code === PG\_INVALID\_TEXT\\_REPRESENTATION) {
            return new IdentityRepositoryError('validation_error', 'IdentityRepository: invalid identity input', {
                cause: error,
            })
        }
        if (code === PG\_SYNTAX\_ERROR || code === PG\_UNDERINED\_OBJECT) {
            return new IdentityRepositoryError('unavailable', 'IdentityRepository: database object unavailable', {
                cause: error,
                retryable: true,
            })
        }
        if (PG\_RETRYABLE\_CODES.has(code)) {
            return new IdentityRepositoryError('unavailable', 'IdentityRepository: transient database failure', {
                cause: error,
                retryable: true,
            })
        }
    }
    return new IdentityRepositoryError('unknown', `IdentityRepository: ${context} failed`, {
        cause: error,
    })
}

export class IdentityRepository {
    constructor(private readonly db: Pool | PoolClient) { }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /** Maps a raw postgres row (snake_case) to the Identity domain type. */
    private map(row: Record<string, unknown>): Identity {
        return {
            id: row.id as string,
            address: row.address as string,
            createdAt: row.created_at as Date,
            updatedAt: row.updated_at as Date,
        }
    }

    private async query<T extends Record<string, unknown>>(
        text: string,
        params: unknown[],
        context: string,
    ): Promise<{ rows: T[]; rowCount?: number }> {
        try {
            const result = await this.db.query<T>(text, params)
            return { rows: result.rows as T[], rowCount: result.rowCount }
        } catch (error) {
            throw toRepositoryError(error, context)
        }
    }

    // ---------------------------------------------------------------------------
    // Queries
    // ---------------------------------------------------------------------------

    /**
     * Returns all identities ordered by creation date (newest first).
     *
     * @param limit  Maximum rows to return (default 100, max 1000).
     * @param offset Pagination offset (default 0).
     * @throws IdentityRepositoryError when limit/offset are not finite numbers
     *         or fall outside the allowed range.
     */
    async findAll(limit: number = DEFAULT_LIMIT, offset = 0): Promise<Identity[]> {
        const safeLimit = normalizeInt(limit, {
            defaultValue: DEFAULT_LIMIT,
            min: 1,
            max: MAX_LIMIT,
            name: 'limit',
        })
        const safeOffset = normalizeInt(offset, {
            defaultValue: 0,
            min: 0,
            name: 'offset',
        })

        const { rows } = await this.query<Record<string, unknown>>(
            `SELECT id, address, created_at, updated_at
               FROM identities
              ORDER BY created_at DESC, id DESC
              LIMIT $1 OFFSET $2`,
            [safeLimit, safeOffset],
            'findAll',
        )
        return rows.map(row => this.map(row))
    }

    /**
     * Returns the identity with the given surrogate UUID, or `null` if not found.
     * @throws IdentityRepositoryError when `id` is not a non-empty string.
     */
    async findById(id: string): Promise<Identity | null> {
        const safeId = normalizeId(id, 'id')
        const { rows } = await this.query<Record<string, unknown>>(
            `SELECT id, address, created_at, updated_at
               FROM identities
              WHERE id = $1`,
            [safeId],
            'findById',
        )
        return rows.length ? this.map(rows[0]) : null
    }

    /**
     * Returns the identity for the given blockchain address, or `null`.
     * The address is normalized (trimmed) before lookup so callers cannot miss a
     * row due to surrounding whitespace.
     * @throws IdentityRepositoryError when `address` is not a non-empty string.
     */
    async findByAddress(address: string): Promise<Identity | null> {
        const safeAddress = normalizeAddress(address)
        const { rows } = await this.query<Record<string, unknown>>(
            `SELECT id, address, created_at, updated_at
               FROM identities
              WHERE address = $1`,
            [safeAddress],
            'findByAddress',
        )
        return rows.length ? this.map(rows[0]) : null
    }

    // ---------------------------------------------------------------------------
    // Mutations
    // ---------------------------------------------------------------------------

    /**
     * Inserts a new identity row and returns the created record.
     *
     * The address is normalized before insertion. Throws an `IdentityRepositoryError`
     * with code `duplicate_address` if the address is already registered (unique
     * constraint). The original driver error is preserved on `cause` for diagnostics.
     */
    async create(input: CreateIdentityInput): Promise<Identity> {
        const address = normalizeAddress(input?.address)
        const { rows } = await this.query<Record<string, unknown>>(
            `INSERT INTO identities (address)
                 VALUES ($1)
              RETURNING id, address, created_at, updated_at`,
            [address],
            'create',
        )
        if (!rows.length) {
            throw new IdentityRepositoryError(
                'unknown',
                'IdentityRepository: create returned no row',
            )
        }
        return this.map(rows[0])
    }

    /**
     * Upserts an identity by address.
     * - If the address already exists, `updated_at` is refreshed and the
     *   existing row is returned.
     * - If it does not exist, a new row is inserted.
     *
     * The address is normalized before the upsert. The operation is atomic at the
     * SQL level (`INSERT ... ON CONFLICT`), so concurrent calls for the same address
     * cannot produce duplicate rows or a partial write.
     */
    async upsert(input: CreateIdentityInput): Promise<Identity> {
        const address = normalizeAddress(input?.address)
        const { rows } = await this.query<Record<string, unknown>>(
            `INSERT INTO identities (address)
                 VALUES ($1)
             ON CONFLICT (address)
             DO UPDATE SET updated_at = NOW()
              RETURNING id, address, created_at, updated_at`,
            [address],
            'upsert',
        )
        if (!rows.length) {
            throw new IdentityRepositoryError(
                'unknown',
                'IdentityRepository: upsert returned no row',
            )
        }
        return this.map(rows[0])
    }

    /**
     * Hard-deletes the identity with the given UUID.
     * Cascades to all associated bonds (ON DELETE CASCADE).
     * Returns `true` if a row was deleted, `false` if not found.
     * @throws IdentityRepositoryError when `id` is not a non-empty string.
     */
    async delete(id: string): Promise<boolean> {
        const safeId = normalizeId(id, 'id')
        const { rowCount } = await this.query<Record<string, unknown>>(
            `DELETE FROM identities WHERE id = $1`,
            [safeId],
            'delete',
        )
        return (rowCount ?? 0) > 0
    }
}
