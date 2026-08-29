import { AppError, ErrorCode } from "../../lib/errors.js";
import type { Pool } from "pg";
import type { Queryable } from "./queryable.js";
import {
  TransactionManager,
  LockTimeoutPolicy,
  LockTimeoutError,
} from "../transaction.js";
import { WalletTransactionsRepository } from "./walletTransactionsRepository.js";
import {
  addDecimals,
  assertWithinNumericBounds,
  compareDecimals,
  DecimalOverflowError,
  DecimalScaleError,
  isValidPositiveDecimal,
} from "../../lib/decimalMath.js";

/**
 * Precision and scale of the `wallets.balance` column
 * (`NUMERIC(36, 18)` — see src/db/schema.ts). Kept in one place so the
 * application-layer bounds check below can never drift from the schema.
 */
const BALANCE_PRECISION = 36;
const BALANCE_SCALE = 18;

/**
 * Thrown when a debit would reduce a wallet's balance below zero.
 */
export class InsufficientBalanceError extends AppError {
  constructor(
    readonly walletId: string,
    readonly available: string,
    readonly requested: string,
  ) {
    super(
      `Insufficient balance in wallet ${walletId}: available ${available}, requested ${requested}`,
      ErrorCode.INSUFFICIENT_FUNDS,
      422,
      { walletId, available, requested },
    );
  }
}

/**
 * Thrown when an amount carries more fractional digits than the
 * `wallets.balance` column's scale supports. Postgres would otherwise
 * silently round the value on write rather than reject it.
 */
export class AmountScaleError extends AppError {
  constructor(readonly amount: string, readonly maxScale: number) {
    super(
      `Amount "${amount}" has more than ${maxScale} fractional digits`,
      ErrorCode.INVALID_FORMAT,
      400,
      { amount, maxScale },
    );
  }
}

/**
 * Thrown when an amount (or the resulting balance) would exceed the
 * magnitude representable by the `wallets.balance` column, matching
 * Postgres's own `NUMERIC(36,18)` bound but rejected before any row lock
 * or write is attempted.
 */
export class AmountOverflowError extends AppError {
  constructor(readonly amount: string, readonly precision: number, readonly scale: number) {
    super(
      `Amount "${amount}" exceeds the maximum representable wallet balance`,
      ErrorCode.VALUE_TOO_LARGE,
      400,
      { amount, precision, scale },
    );
  }
}

/**
 * Validate that `amount` is exactly representable by the `wallets.balance`
 * column (correct scale, no overflow) before any lock is acquired or state
 * changed. Translates the pure {@link decimalMath} errors into typed,
 * documented `AppError`s so callers never see a raw driver exception.
 */
function assertValidWalletAmount(amount: string): void {
  try {
    assertWithinNumericBounds(amount, BALANCE_PRECISION, BALANCE_SCALE);
  } catch (error) {
    if (error instanceof DecimalScaleError) {
      throw new AmountScaleError(amount, BALANCE_SCALE);
    }
    if (error instanceof DecimalOverflowError) {
      throw new AmountOverflowError(amount, BALANCE_PRECISION, BALANCE_SCALE);
    }
    throw error;
  }
}

/**
 * Thrown when attempting to create a wallet that already exists.
 */
export class WalletAlreadyExistsError extends AppError {
  constructor(readonly address: string) {
    super(
      `Wallet with address ${address} already exists`,
      ErrorCode.CONFLICT,
      409,
      { address },
    );
  }
}

export interface Wallet {
  id: string;
  address: string;
  balance: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWalletInput {
  address: string;
  initialBalance?: string;
  currency?: string;
}

export interface DebitResult {
  wallet: Wallet;
  previousBalance: string;
  newBalance: string;
  debitedAmount: string;
}

type WalletRow = {
  id: string;
  address: string;
  balance: string;
  currency: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

const mapWallet = (row: WalletRow): Wallet => ({
  id: row.id,
  address: row.address,
  balance: row.balance,
  currency: row.currency,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
});

/**
 * Repository for managing wallet balances with atomic debit operations.
 *
 * Key features:
 * - Row-level locking (SELECT FOR UPDATE) to prevent race conditions
 * - Atomic debit operations that never allow negative balances
 * - Configurable lock timeouts with automatic retry on contention
 * - Transaction isolation to ensure consistency under concurrency
 */
export class WalletsRepository {
  private readonly txManager?: TransactionManager;
  private readonly transactionsRepo: WalletTransactionsRepository;

  /**
   * @param db   - A `Queryable` (Pool or PoolClient) for read/write queries.
   * @param pool - The underlying `Pool`; required for `debit()` which
   *               needs an exclusive client to run a serializable transaction.
   * @param lockTimeouts - Optional lock timeout configuration for transactions.
   */
  constructor(
    private readonly db: Queryable,
    private readonly pool?: Pool,
    lockTimeouts?: { readonly: number; default: number; critical: number },
  ) {
    if (pool) {
      this.txManager = new TransactionManager(pool, lockTimeouts);
    }
    this.transactionsRepo = new WalletTransactionsRepository(db);
  }

  /**
   * Create a new wallet with an optional initial balance.
   *
   * @param input - Wallet creation parameters.
   * @returns The newly created wallet.
   * @throws {WalletAlreadyExistsError} when a wallet with the address already exists.
   */
  async create(input: CreateWalletInput): Promise<Wallet> {
    try {
      const result = await this.db.query<WalletRow>(
        `
        INSERT INTO wallets (address, balance, currency)
        VALUES ($1, $2, $3)
        RETURNING id, address, balance, currency, created_at, updated_at
        `,
        [input.address, input.initialBalance ?? "0", input.currency ?? "USD"],
      );

      return mapWallet(result.rows[0]);
    } catch (error: any) {
      // PostgreSQL unique constraint violation
      if (error.code === "23505") {
        throw new WalletAlreadyExistsError(input.address);
      }
      throw error;
    }
  }

  /**
   * Find a wallet by its unique ID.
   */
  async findById(id: string): Promise<Wallet | null> {
    const result = await this.db.query<WalletRow>(
      `
      SELECT id, address, balance, currency, created_at, updated_at
      FROM wallets
      WHERE id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapWallet(result.rows[0]) : null;
  }

  /**
   * Find a wallet by its blockchain address.
   */
  async findByAddress(address: string): Promise<Wallet | null> {
    const result = await this.db.query<WalletRow>(
      `
      SELECT id, address, balance, currency, created_at, updated_at
      FROM wallets
      WHERE address = $1
      `,
      [address],
    );

    return result.rows[0] ? mapWallet(result.rows[0]) : null;
  }

  /**
   * List all wallets, optionally filtered by currency.
   */
  async list(currency?: string): Promise<Wallet[]> {
    const query = currency
      ? `
        SELECT id, address, balance, currency, created_at, updated_at
        FROM wallets
        WHERE currency = $1
        ORDER BY created_at DESC
        `
      : `
        SELECT id, address, balance, currency, created_at, updated_at
        FROM wallets
        ORDER BY created_at DESC
        `;

    const result = await this.db.query<WalletRow>(
      query,
      currency ? [currency] : [],
    );

    return result.rows.map(mapWallet);
  }

  /**
   * Atomically credit (add) an amount to a wallet's balance.
   *
   * This operation uses row-level locking to ensure consistency under concurrency
   * and records the transaction in the immutable ledger.
   *
   * @param id     - Wallet ID.
   * @param amount - Positive numeric string to add.
   * @returns The updated wallet.
   * @throws {Error} when the wallet does not exist.
   * @throws {Error} when `pool` was not supplied to the constructor.
   */
  async credit(id: string, amount: string): Promise<Wallet> {
    if (!this.txManager) {
      throw new Error(
        "WalletsRepository.credit() requires a Pool instance passed to the constructor",
      );
    }

    // Reject malformed, zero, or negative amounts before acquiring the row lock.
    if (!isValidPositiveDecimal(amount)) {
      throw new Error(`Invalid credit amount: "${amount}"`);
    }

    // Reject invalid scale or self-overflow before acquiring the row lock —
    // an amount that doesn't fit the column on its own can never succeed.
    assertValidWalletAmount(amount);

    return this.txManager.withTransaction(
      async (client) => {
        // Lock the row
        const lockResult = await client.query<WalletRow>(
          `
          SELECT id, address, balance, currency, created_at, updated_at
          FROM wallets
          WHERE id = $1
          FOR UPDATE
          `,
          [id],
        );

        if (!lockResult.rows[0]) {
          throw new Error(`Wallet ${id} not found`);
        }

        const previousBalance = lockResult.rows[0].balance;

        // Reject if crediting this amount would push the balance beyond the
        // column's representable magnitude. Checked exactly, in application
        // code, before any write — rather than surfacing a raw Postgres
        // `22003 numeric_field_overflow` from the UPDATE below.
        const projectedBalance = addDecimals(previousBalance, amount);
        assertValidWalletAmount(projectedBalance);

        // Update balance
        const updateResult = await client.query<WalletRow>(
          `
          UPDATE wallets
          SET balance = balance + $2::NUMERIC,
              updated_at = NOW()
          WHERE id = $1
          RETURNING id, address, balance, currency, created_at, updated_at
          `,
          [id, amount],
        );

        const updatedWallet = mapWallet(updateResult.rows[0]);

        // Record transaction in immutable ledger (within same transaction)
        const txRepo = new WalletTransactionsRepository(client);
        await txRepo.record({
          walletId: id,
          type: "credit",
          amount,
          previousBalance,
          newBalance: updatedWallet.balance,
        });

        return updatedWallet;
      },
      {
        policy: LockTimeoutPolicy.DEFAULT,
        isolationLevel: "REPEATABLE READ",
        retryOnLockTimeout: true,
        maxRetries: 2,
      },
    );
  }

  /**
   * Atomically debit (subtract) an amount from a wallet's balance using row-level locking.
   *
   * The operation runs inside a `REPEATABLE READ` transaction with
   * `SELECT … FOR UPDATE` and configurable lock timeout. Concurrent debits
   * on the same wallet are serialized at the DB level. Transactions are recorded
   * in the immutable ledger.
   *
   * Uses DEFAULT lock timeout policy (2s default) with automatic retry
   * on lock timeout to balance throughput and contention fairness.
   *
   * **Guarantees:**
   * 1. Balance never goes negative (enforced by CHECK constraint + pre-check)
   * 2. No lost updates (row-level lock serializes concurrent operations)
   * 3. Exactly-once semantics (transaction atomicity)
   * 4. Immutable ledger recording (every debit is permanently recorded)
   *
   * @param id     - Wallet ID.
   * @param amount - Positive numeric string to subtract.
   * @returns Detailed result including previous and new balance.
   * @throws {InsufficientBalanceError} when `amount > wallet.balance`.
   * @throws {LockTimeoutError}         when lock cannot be acquired within timeout.
   * @throws {Error}                    when the wallet does not exist.
   * @throws {Error}                    when `pool` was not supplied to the constructor.
   */
  async debit(id: string, amount: string): Promise<DebitResult> {
    if (!this.txManager) {
      throw new Error(
        "WalletsRepository.debit() requires a Pool instance passed to the constructor",
      );
    }

    // Reject malformed, zero, or negative amounts before acquiring the row lock.
    if (!isValidPositiveDecimal(amount)) {
      throw new Error(`Invalid debit amount: "${amount}"`);
    }

    // Reject invalid scale or overflow before acquiring the row lock. A
    // debit can never increase the balance's magnitude, but an amount with
    // more fractional digits than the column supports would still be
    // silently rounded by Postgres — mismatching the exact amount recorded
    // in the immutable ledger below.
    assertValidWalletAmount(amount);

    return this.txManager.withTransaction(
      async (client) => {
        // Lock the row so concurrent debits queue up rather than racing.
        const lockResult = await client.query<WalletRow>(
          `
          SELECT id, address, balance, currency, created_at, updated_at
          FROM wallets
          WHERE id = $1
          FOR UPDATE
          `,
          [id],
        );

        if (!lockResult.rows[0]) {
          throw new Error(`Wallet ${id} not found`);
        }

        const current = mapWallet(lockResult.rows[0]);
        const previousBalance = current.balance;

        // Number() loses precision beyond ~15 significant digits and can silently
        // permit an overdraft on large or high-scale balances. compareDecimals()
        // uses BigInt-scaled integer arithmetic and is always exact.
        if (compareDecimals(amount, current.balance) > 0) {
          throw new InsufficientBalanceError(id, current.balance, amount);
        }

        // Perform the debit using NUMERIC arithmetic to avoid floating-point errors
        const updateResult = await client.query<WalletRow>(
          `
          UPDATE wallets
          SET balance = balance - $2::NUMERIC,
              updated_at = NOW()
          WHERE id = $1
          RETURNING id, address, balance, currency, created_at, updated_at
          `,
          [id, amount],
        );

        const updatedWallet = mapWallet(updateResult.rows[0]);

        // Record transaction in immutable ledger (within same transaction)
        const txRepo = new WalletTransactionsRepository(client);
        await txRepo.record({
          walletId: id,
          type: "debit",
          amount,
          previousBalance,
          newBalance: updatedWallet.balance,
        });

        return {
          wallet: updatedWallet,
          previousBalance,
          newBalance: updatedWallet.balance,
          debitedAmount: amount,
        };
      },
      {
        policy: LockTimeoutPolicy.DEFAULT,
        isolationLevel: "REPEATABLE READ",
        retryOnLockTimeout: true,
        maxRetries: 2,
      },
    );
  }

  /**
   * Delete a wallet by ID.
   *
   * @returns `true` if the wallet was deleted, `false` if it didn't exist.
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.query(
      `
      DELETE FROM wallets
      WHERE id = $1
      `,
      [id],
    );

    return (result.rowCount ?? 0) > 0;
  }
}
