import type { Pool, PoolClient } from 'pg'
import type { CreateIdentityInput, Identity } from '../../types/index.ts'

/**
 * Repository level errors. These are thrown instead of letting raw driver errors
 * escape so callers can distinguish between validation failures, conflicts and
 * transient failures without inspecting driver internals.
 */
export class IdentityValidationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'IdentityValidationError'
    }
}

export class IdentityConflictError extends Error {
    constructor(message = 'identity already exists') {
        super(message)
        this.name = 'IdentityConflictError'
    }
}

export class IdentityNotFoundError extends Error {
    constructor(message = 'identity not found') {
        super(message)
        this.name = 'IdentityNotFoundError'
    }
}

export class IdentityTransientError extends Error {
    constructor(message: string, readonly cause?: unknown) {
        super(message)
        this.name = 'IdentityTransientError'
    }
}

/**
 * Postgres error codes that represent transient conditions worth retrying.
 * See https://www.postgresql.org/docs/current/error-codes.html
 */
const TRANSIENT_PG_CODES = new Set([
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '08007', // cannot_connect_now
    '40001', // transaction_rollback
    '40P01', // serialization_failure
    '40P02', // deadlock
    '53000', // insufficient_resources
    '57P01', // cannot_connect_now
    '57P03', // admin_shutdown
])

const UNIQUE_VIOLATION_CODE = '23505'

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRy_BASE_DELAY_MS = 25
const MAX_RETRY_BASE_DELAY_MS = 1000

function isPgError(err: unknown): err is { code?: string; constraint?: string } {
    return typeof err === 'object' && err !== null && 'code' in err
}

function isTransient(err: unknown): boolean {
    if (!isPgError(err)) {
        // Network level failures from the pg driver (e.g. ECONNRESET, ECONNREFUSID)
        // are not Postgres error objects but are still worth retrying.
        const code = (err as { code?: string } | undefined)?.code
        return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT'
    }
    return TRANSIENT_PG_CODES.has(err.code ?? '')
}

function isUniqueViolation(err: unknown): boolean {
    return isPgError(err) && err.code === UNIQUE_VIOLATION_CODE
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface IdentityRepositoryOptions {
    /** Maximum number of attempts (1 initial + retries). Defaults to 3. */
    maxRetries?: number
    /** Base delay in ms for exponential backoff. Defaults to 25. */
    retryBaseDelayMs?: number
    /** Optional hook for testing/observability; called before each retry sleep. */
    onRetry?: (attempt: number, error: unknown) => void
}

/**
 * Repository for the `identities` table.
 *
 * Invariants:
* - All read methods return either a well-formed `Identity` or `null`; no raw rows escape.
 * - `create` is atomic and never silently overwrites an existing address.
 * - `upsert` is idempotent with respect to `id`/`address`/`created_at`; only `updated_at`
 *   is refreshed on conflict.
 * - Transient driver failures are retried with bounded exponential backoff;
 *   non-transient failures fail fast and are never retried.
 * - Invalid input is rejected before any QL is issued.
 */
export class IdentityRepository {
    private readonly maxRetries: number
    private readonly retryBaseDelayMs: number
    private readonly onRetry?: (attempt: number, error: unknown) => void

    constructor(
        private readonly db: Pool | PoolClient,
        options: IdentityRepositoryOptions = {},
    ) {
        this.maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_MAX_RETRIES)
        this.retryBaseDelayMs = Math.min(
            Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRy_BASE_DELAY_MS),
            MAX_RETRY_BASE_DELAY_MS,
        )
        this.onRetry = options.onRetry
    }

    // ----------------------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------------------

    /** Maps a raw postgres row (snake_case) to the Identity domain type. */
    private map(row: Record<string, unknown>): Identity {
        return {
            id: row.id as string,
            address: row.address as string,
            createdAt: row.created_at as Date,
            updatedAt: row.updated_at as Date,
        }
    }

    /**
     * Runs a query with bounded retries for transient failures.
     *
     * The retry loop is safe because every query in this repository is a
     * single statement (implicitly atomic in Postgres). Retrying a failed
     * single statement cannot produce a partially applied write.
     */
    private async queryWithRetry<T>(
        sql: string,
        params: unknown[],
    ): Promise<{ rows: T;[]; rowCount: number | null }> {
        let attempt = 0
        // eslint-disable-next-line no-constant-condition
        while (true) {
            attempt += 1
            try {
                const result = await this.db.query(sql, params)
                return {
                    rows: result.rows as T,
                    rowCount: result.rowCount ?? null,
                }
            } catch (err) {
                if (attempt >= this.maxRetries || !isTransient(err)) {
                    throw err
                }
                this.onRetry?.(attempt, err)
                const delay = this.retryBaseDelayMs * 2 ** (attempt - 1)
                await sleep(delay)
            }
        }
    }

    /** Validates a blockchain address before it reaches the database. */
    private assertAddress(address: unknown): asserts address is string {
        if (typeof address !== 'string' || address.trim().length === 0) {
            throw new IdentityValidationError('address must be a non-empty string')
        }
        if (address.length > 256) {
            throw new IdentityValidationError('address exceeds 256 characters')
        }
    }

    /** Validates a surrogate UUID before it reaches the database. */
    private assertId(id: unknown): asserts id is string {
        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new IdentityValidationError('id must be a non-empty string')
        }
    }

    /** Normalizes and clamps pagination parameters to safe bounds. */
    private normalizePagination(limit: unknown, offset: unknown): [number, number] {
        const limitNum = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 100
        const offsetNum =
            typeof offset === 'number' && Number.isFinite(offset) ? Math.floor(offset) : 0
        const safeLimit = Math.min(Math.max(1, limitNum), 1000)
        const safeOffset = Math.max(0, offsetNum)
        return [safeLimit, safeOffset]
    }

    // ----------------------------------------------------------------------------
    // Queries
    // ----------------------------------------------------------------------------

    /**
     * Returns all identities ordered by creation date (newest first).
     * @param limit  Maximum rows to return (default 100, clamped to [1, 1000]).
     * @param offset Pagination offset (default 0, clamped to >= 0).
     */
    async findAll(limit = 100, offset = 0): Promise<Identity[]> {
        const [safeLimit, safeOffset] = this.normalizePagination(limit, offset)
        const { rows } = await this.queryWithRetry<Record<string, unknown>>(
            `SELECT id, address, created_at, updated_at
               FROM identities
              ORDER BY created_at DESC, id DESC
              LIMIT $1 OFFSET $2`,
            [safeLimit, safeOffset],
        )
        return rows.map((r) => this.map(r))
    }

    /**
     * Returns the identity with the given surrogate UUID, or `null` if not found.
     */
    async findById(id: string): Promise<Identity | null> {
        this.assertId(id)
        const { rows } = await this.queryWithRetry<Record<string, unknown>>(
            `SELECT id, address, created_at, updated_at
               FROM identities
              WHERE id = $1`,
            [id],
        )
        return rows.length ? this.map(rows[0]) : null
    }

    /**
     * Returns the identity for the given blockchain address, or `null`.
     */
    async findByAddress(address: string): Promise<Identity | null> {
        this.assertAddress(address)
        const { rows } = await this.queryWithRetry<Record<string, unknown>>(
            `SELECT id, address, created_at, updated_at
               FROM identities
              WHERE address = $1`,
            [address],
        )
        return rows.length ? this.map(rows[0]) : null
    }

    // ----------------------------------------------------------------------------
    // Mutations
    // ----------------------------------------------------------------------------

    /**
     * Inserts a new identity row and returns the created record.
     *
     * Throws `IdentityConflictError` if `address` is already registered.
     * This is deterministic and never overwrites an existing row.
     */
    async create(input: CreateIdentityInput): Promise<Identity> {
        this.assertAddress(input?.address)
        try {
            const { rows } = await this.queryWithRetry<Record<string, unknown>>(
                `INSERT INTO identities (address)
                 VALUES ($1)
              RETURNING id, address, created_at, updated_at`,
                [input.address],
            )
            return this.map(rows[0])
        } catch (err) {
            if (isUniqueViolation(err)) {
                throw new IdentityConflictError()
            }
            throw err
        }
    }

    /**
     * Upserts an identity by address.
     * - If the address already exists, `updated_at` is refreshed and the
     *   existing row is returned.
     * - If it does not exist, a new row is inserted.
     *
     * The operation is idempotent and safe under concurrency: two concurrent
     * upserts for the same address will both succeed and return the same `id`.
     */
    async upsert(input: CreateIdentityInput): Promise<Identity> {
        this.assertAddress(input?.address)
        const { rows } = await this.queryWithRetry<Record<string, unknown>>(
            `INSERT INTO identities (address)
               VALUES ($1)
           ON CONFLICT (address)
           DO UPDATE SET updated_at = NOW
             RETURNING id, address, created_at, updated_at`,
            [input.address],
        )
        return this.map(rows[0])
    }

    /**
     * Hard-deletes the identity with the given UUID.
     * Cascades to all associated bonds (ON DELETE CASCADE).
     * Returns `true` if a row was deleted, `false` if not found.
     */
    async delete(id: string): Promise<boolean> {
        this.assertId(id)
        const { rowCount } = await this.queryWithRetry<unknown>(
            `DELETE FROM identities WHERE id = $1`,
            [id],
        )
        return (rowCount ?? 0) > 0
    }
}
