import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: Initial Schema
 * 
 * Description: Creates the initial database schema for the Credence backend.
 * Includes tables for identities, attestations, and reputation scores.
 * 
 * Tables created:
 * - identities: Stores identity/bond state synced from the blockchain
 * - attestations: Stores attestation records between identities
 * - reputation_scores: Caches calculated reputation scores
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Identities table - stores identity and bond state
  pgm.createTable('identities', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    address: {
      type: 'varchar(64)',
      notNull: true,
      unique: true,
    },
    bonded_amount: {
      type: 'varchar(78)', // Large enough for uint256 in wei
      notNull: true,
      default: '0',
    },
    bond_start: {
      type: 'timestamp',
    },
    bond_duration: {
      type: 'integer', // Duration in seconds
    },
    active: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  })

  // Add index on address for fast lookups
  pgm.createIndex('identities', 'address')
  pgm.createIndex('identities', 'active')
  pgm.createIndex('identities', 'updated_at')

  // Attestations table - stores attestations between identities
  pgm.createTable('attestations', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    bond_id: {
      type: 'integer',
      notNull: true,
    },
    attester_address: {
      type: 'varchar(64)',
      notNull: true,
    },
    subject_address: {
      type: 'varchar(64)',
      notNull: true,
    },
    score: {
      type: 'integer',
      notNull: true,
    },
    note: {
      type: 'text',
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  })

  // Add indexes for attestation queries
  pgm.createIndex('attestations', 'attester_address')
  pgm.createIndex('attestations', 'subject_address')
  pgm.createIndex('attestations', 'bond_id')

  // Reputation scores table - caches calculated scores
  pgm.createTable('reputation_scores', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    address: {
      type: 'varchar(64)',
      notNull: true,
      unique: true,
    },
    total_score: {
      type: 'decimal(20, 10)',
      notNull: true,
      default: 0,
    },
    bond_score: {
      type: 'decimal(20, 10)',
      notNull: true,
      default: 0,
    },
    attestation_score: {
      type: 'decimal(20, 10)',
      notNull: true,
      default: 0,
    },
    time_weight: {
      type: 'decimal(10, 8)',
      notNull: true,
      default: 0,
    },
    calculated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  })

  // Add indexes for reputation queries
  pgm.createIndex('reputation_scores', 'address')
  pgm.createIndex('reputation_scores', 'total_score')
  pgm.createIndex('reputation_scores', 'calculated_at')

  // Add foreign key constraints
  pgm.addConstraint(
    'reputation_scores',
    'fk_reputation_scores_identity',
    {
      foreignKeys: {
        columns: 'address',
        references: 'identities(address)',
        onDelete: 'CASCADE',
      },
    }
  )

  // Add triggers for updated_at timestamps
  pgm.sql(`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = current_timestamp;
      RETURN NEW;
    END;
    $$ language 'plpgsql';
  `)

  pgm.sql(`
    CREATE TRIGGER update_identities_updated_at
      BEFORE UPDATE ON identities
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `)

  pgm.sql(`
    CREATE TRIGGER update_reputation_scores_updated_at
      BEFORE UPDATE ON reputation_scores
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `)
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop triggers first
  pgm.sql('DROP TRIGGER IF EXISTS update_reputation_scores_updated_at ON reputation_scores;')
  pgm.sql('DROP TRIGGER IF EXISTS update_identities_updated_at ON identities;')
  pgm.sql('DROP FUNCTION IF EXISTS update_updated_at_column();')

  // Drop tables in reverse order (respecting foreign key constraints)
  pgm.dropTable('reputation_scores')
  pgm.dropTable('attestations')
  pgm.dropTable('identities')
}
