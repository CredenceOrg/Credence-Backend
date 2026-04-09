import { AppError, ErrorCode } from '../../lib/errors.js'
import type { Pool } from 'pg'
import type { Queryable } from './queryable.js'
import {
  TransactionManager,
  LockTimeoutPolicy,
  LockTimeoutError,
} from '../transaction.js'

export type BondStatus = 'active' | 'released' | 'slashed'

/**
 * Thrown when a debit would reduce a bond's amount below zero.
 */
export class InsufficientFundsError extends AppError {
  constructor(
    readonly bondId: number,
    readonly available: string,
    readonly requested: string
  ) {
    super(
      `Insufficient funds on bond ${bondId}: available ${available}, requested ${requested}`,
      ErrorCode.INSUFFICIENT_FUNDS,
      422,
      { bondId, available, requested }
    )
  }
}

export interface Bond {
  id: number
  identityAddress: string
  amount: string
  startTime: Date
  durationDays: number
  status: BondStatus
  createdAt: Date
}

export interface CreateBondInput {
  identityAddress: string
  amount: string
  startTime: Date
  durationDays: number
  status?: BondStatus
}

type BondRow = {
  id: string | number
  identity_address: string
  amount: string
  start_time: Date | string
  duration_days: number
  status: BondStatus
  created_at: Date | string
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const mapBond = (row: BondRow): Bond => ({
  id: Number(row.id),
  identityAddress: row.identity_address,
  amount: row.amount,
  startTime: toDate(row.start_time),
  durationDays: row.duration_days,
  status: row.status,
  createdAt: toDate(row.created_at),
})

export class BondsRepository {
  private readonly txManager?: TransactionManager

  /**
   * @param db   - A `Queryable` (Pool or PoolClient) for read/write queries.
   * @param pool - The underlying `Pool`; required only for `debit()` which
   *               needs an exclusive client to run a serialisable transaction.
   * @param lockTimeouts - Optional lock timeout configuration for transactions.
   */
  constructor(
    private readonly db: Queryable,
    private readonly pool?: Pool,
    lockTimeouts?: { readonly: number; default: number; critical: number }
  ) {
    if (pool) {
      this.txManager = new TransactionManager(pool, lockTimeouts)
    }
  }

  async create(input: CreateBondInput): Promise<Bond> {
    const result = await this.db.query<BondRow>(
      `
      INSERT INTO bonds (identity_address, amount, start_time, duration_days, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, identity_address, amount, start_time, duration_days, status, created_at
      `,
      [
        input.identityAddress,
        input.amount,
        input.startTime,
        input.durationDays,
        input.status ?? 'active',
      ]
    )

    return mapBond(result.rows[0])
  }

  async findById(id: number): Promise<Bond | null> {
    const result = await this.db.query<BondRow>(
      `
      SELECT id, identity_address, amount, start_time, duration_days, status, created_at
      FROM bonds
      WHERE id = $1
      `,
      [id]
    )

    return result.rows[0] ? mapBond(result.rows[0]) : null
  }

  async listByIdentity(identityAddress: string): Promise<Bond[]> {
    const result = await this.db.query<BondRow>(
      `
      SELECT id, identity_address, amount, start_time, duration_days, status, created_at
      FROM bonds
      WHERE identity_address = $1
      ORDER BY start_time DESC, id DESC
      `,
      [identityAddress]
    )

    return result.rows.map(mapBond)
  }

  async updateStatus(id: number, status: BondStatus): Promise<Bond | null> {
    const result = await this.db.query<BondRow>(
      `
      UPDATE bonds
      SET status = $2
      WHERE id = $1
      RETURNING id, identity_address, amount, start_time, duration_days, status, created_at
      `,
      [id, status]
    )

    return result.rows[0] ? mapBond(result.rows[0]) : null
  }

  /**
   * Atomically debit `amount` from a bond's balance using a row-level lock.
   *
   * The operation runs inside a `REPEATABLE READ` transaction with
   * `SELECT … FOR UPDATE` and configurable lock timeout. Concurrent debits
   * on the same bond are serialised at the DB level.
   *
   * Uses CRITICAL lock timeout policy (10s default) with automatic retry
   * on lock timeout to balance throughput and contention fairness.
   *
   * @param id     - Bond primary key.
   * @param amount - Positive numeric string to subtract (same unit as `Bond.amount`).
   * @returns      The updated bond after the debit.
   * @throws {InsufficientFundsError} when `amount > bond.amount`.
   * @throws {LockTimeoutError}       when lock cannot be acquired within timeout.
   * @throws {Error}                  when the bond does not exist.
   * @throws {Error}                  when `pool` was not supplied to the constructor.
   */
  async debit(id: number, amount: string): Promise<Bond> {
    if (!this.txManager) {
      throw new Error(
        'BondsRepository.debit() requires a Pool instance passed to the constructor'
      )
    }

    return this.txManager.withTransaction(
      async (client) => {
        // Lock the row so concurrent debits queue up rather than racing.
        const lockResult = await client.query<BondRow>(
          `
          SELECT id, identity_address, amount, start_time, duration_days, status, created_at
          FROM bonds
          WHERE id = $1
          FOR UPDATE
          `,
          [id]
        )

        if (!lockResult.rows[0]) {
          throw new Error(`Bond ${id} not found`)
        }

        const current = mapBond(lockResult.rows[0])

        // Use NUMERIC arithmetic in JS with BigInt-safe string comparison to
        // avoid floating-point drift on large wei values.
        const availableNum = Number(current.amount)
        const requestedNum = Number(amount)

        if (requestedNum > availableNum) {
          throw new InsufficientFundsError(id, current.amount, amount)
        }

        const updateResult = await client.query<BondRow>(
          `
          UPDATE bonds
          SET amount = (amount - $2::NUMERIC)
          WHERE id = $1
          RETURNING id, identity_address, amount, start_time, duration_days, status, created_at
          `,
          [id, amount]
        )

        return mapBond(updateResult.rows[0])
      },
      {
        policy: LockTimeoutPolicy.CRITICAL,
        isolationLevel: 'REPEATABLE READ',
        retryOnLockTimeout: true,
        maxRetries: 2,
      }
    )
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query(
      `
      DELETE FROM bonds
      WHERE id = $1
      `,
      [id]
    )

    return (result.rowCount ?? 0) > 0
  }
}
