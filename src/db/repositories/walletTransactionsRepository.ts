import type { Queryable } from "./queryable.js";

export interface WalletTransaction {
  id: string;
  walletId: string;
  type: "credit" | "debit";
  amount: string;
  previousBalance: string;
  newBalance: string;
  createdAt: Date;
}

type WalletTransactionRow = {
  id: string;
  wallet_id: string;
  type: "credit" | "debit";
  amount: string;
  previous_balance: string;
  new_balance: string;
  created_at: Date | string;
};

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

const mapTransaction = (row: WalletTransactionRow): WalletTransaction => ({
  id: row.id,
  walletId: row.wallet_id,
  type: row.type,
  amount: row.amount,
  previousBalance: row.previous_balance,
  newBalance: row.new_balance,
  createdAt: toDate(row.created_at),
});

export class WalletTransactionsRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Record a transaction in the immutable ledger.
   * Called automatically by credit() and debit() operations.
   */
  async record(params: {
    walletId: string;
    type: "credit" | "debit";
    amount: string;
    previousBalance: string;
    newBalance: string;
  }): Promise<WalletTransaction> {
    const { walletId, type, amount, previousBalance, newBalance } = params;

    const result = await this.db.query<WalletTransactionRow>(
      `
      INSERT INTO wallet_transactions (wallet_id, type, amount, previous_balance, new_balance)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, wallet_id, type, amount, previous_balance, new_balance, created_at
      `,
      [walletId, type, amount, previousBalance, newBalance],
    );

    return mapTransaction(result.rows[0]);
  }

  /**
   * Retrieve all transactions for a wallet, ordered by creation time (oldest first).
   */
  async findByWalletId(walletId: string): Promise<WalletTransaction[]> {
    const result = await this.db.query<WalletTransactionRow>(
      `
      SELECT id, wallet_id, type, amount, previous_balance, new_balance, created_at
      FROM wallet_transactions
      WHERE wallet_id = $1
      ORDER BY created_at ASC
      `,
      [walletId],
    );

    return result.rows.map(mapTransaction);
  }

  /**
   * Retrieve transactions for a wallet within a date range.
   */
  async findByWalletIdInRange(
    walletId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<WalletTransaction[]> {
    const result = await this.db.query<WalletTransactionRow>(
      `
      SELECT id, wallet_id, type, amount, previous_balance, new_balance, created_at
      FROM wallet_transactions
      WHERE wallet_id = $1 AND created_at >= $2 AND created_at <= $3
      ORDER BY created_at ASC
      `,
      [walletId, startDate, endDate],
    );

    return result.rows.map(mapTransaction);
  }

  /**
   * Get the transaction count for a wallet.
   */
  async getCountByWalletId(walletId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*) as count
      FROM wallet_transactions
      WHERE wallet_id = $1
      `,
      [walletId],
    );

    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Reconstruct wallet balance at a specific point in time by replaying the ledger.
   * Useful for auditing and reconciliation.
   */
  async getBalanceAtTime(walletId: string, timestamp: Date): Promise<string | null> {
    const result = await this.db.query<{ new_balance: string }>(
      `
      SELECT new_balance
      FROM wallet_transactions
      WHERE wallet_id = $1 AND created_at <= $2
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [walletId, timestamp],
    );

    return result.rows[0]?.new_balance ?? null;
  }
}
