import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: Add API Keys Table with Scopes
 * 
 * Description: Creates the api_keys table to store API keys with their associated scopes.
 * This enables fine-grained access control through the requireScope middleware.
 * 
 * Table created:
 * - api_keys: Stores API key metadata including hashed keys, scopes, and ownership
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('api_keys', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    hashed_key: {
      type: 'varchar(64)',
      notNull: true,
      unique: true,
    },
    prefix: {
      type: 'varchar(8)',
      notNull: true,
    },
    scopes: {
      type: 'text[]',
      notNull: true,
      default: pgm.func("ARRAY[]::text[]"),
    },
    tier: {
      type: 'varchar(20)',
      notNull: true,
      default: 'free',
    },
    owner_id: {
      type: 'varchar(255)',
      notNull: true,
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    last_used_at: {
      type: 'timestamp',
    },
    active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
  })

  // Add indexes for common query patterns
  pgm.createIndex('api_keys', 'hashed_key')
  pgm.createIndex('api_keys', 'prefix')
  pgm.createIndex('api_keys', 'owner_id')
  pgm.createIndex('api_keys', 'active')
  
  // Composite index for active keys by owner
  pgm.createIndex('api_keys', ['owner_id', 'active'])

  // Add check constraint for valid tier values
  pgm.addConstraint('api_keys', 'api_keys_tier_check', {
    check: "tier IN ('free', 'pro', 'enterprise')",
  })

  // Add trigger for updated_at-like behavior on last_used_at
  pgm.sql(`
    CREATE OR REPLACE FUNCTION update_last_used_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.last_used_at = current_timestamp;
      RETURN NEW;
    END;
    $$ language 'plpgsql';
  `)

  // Note: This trigger would be used when validating keys, not on every UPDATE
  // The validation logic will update last_used_at directly
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS update_api_keys_last_used_at ON api_keys;')
  pgm.sql('DROP FUNCTION IF EXISTS update_last_used_at();')
  pgm.dropTable('api_keys')
}
