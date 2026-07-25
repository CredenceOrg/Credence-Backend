// Migration to create wallet_transactions immutable ledger table
import { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('wallet_transactions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    wallet_id: { type: 'uuid', notNull: true, references: 'wallets(id)' },
    type: { type: 'text', notNull: true, check: "type IN ('credit', 'debit')" },
    amount: { type: 'numeric(36,18)', notNull: true, check: 'amount > 0' },
    previous_balance: { type: 'numeric(36,18)', notNull: true, check: 'previous_balance >= 0' },
    new_balance: { type: 'numeric(36,18)', notNull: true, check: 'new_balance >= 0' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });

  pgm.createIndex('wallet_transactions', 'wallet_id');
  pgm.createIndex('wallet_transactions', ['wallet_id', 'created_at']);
  pgm.createIndex('wallet_transactions', 'created_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('wallet_transactions');
}
