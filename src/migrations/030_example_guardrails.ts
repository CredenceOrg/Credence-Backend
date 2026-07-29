import { MigrationBuilder } from 'node-pg-migrate'

export const shorthands = undefined;

// Note: Disabling transaction for the entire migration is necessary to create indexes CONCURRENTLY.
// If your migration requires both transactional DDL and concurrent indexing, consider splitting them into multiple files.
export const config = {
  transaction: false
}

export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Lock Timeouts for DDL
  // We apply lock_timeout and statement_timeout at the session level to avoid lock pileups.
  pgm.sql(`
    SET lock_timeout = '2s';
    SET statement_timeout = '5s';
  `);

  // 2. Safe DDL Operation
  pgm.addColumn('identities', 'metadata', {
    type: 'jsonb',
    default: '{}',
    notNull: true,
  });

  // 3. Online/Concurrent Index Creation
  // This must be done outside a transaction (which is why config.transaction = false)
  pgm.createIndex('identities', 'metadata', {
    method: 'CONCURRENTLY',
    name: 'idx_identities_metadata_concurrent',
    // Example: only index active identities (Partial Index)
    where: 'active = true'
  });

  // Reset timeouts for data migration (which may take longer)
  pgm.sql(`
    RESET lock_timeout;
    RESET statement_timeout;
  `);

  // 4. Batching Large Data Migrations
  // Example of a batched update in raw SQL (PL/pgSQL block) to avoid full table locks.
  // We process in chunks and use pg_sleep to yield back to other operations.
  pgm.sql(`
    DO $$
    DECLARE
      v_batch_size INT := 1000;
      v_row_count INT;
      v_last_id INT := 0;
    BEGIN
      LOOP
        WITH batch AS (
          SELECT id FROM identities 
          WHERE id > v_last_id 
          ORDER BY id ASC 
          LIMIT v_batch_size
        )
        UPDATE identities i
        SET metadata = '{"migrated": true}'::jsonb
        FROM batch b
        WHERE i.id = b.id;
        
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        
        IF v_row_count = 0 THEN
          EXIT; -- All rows processed
        END IF;

        -- Update v_last_id to the max id of the current batch
        SELECT MAX(id) INTO v_last_id FROM (
          SELECT id FROM identities 
          WHERE id > v_last_id 
          ORDER BY id ASC 
          LIMIT v_batch_size
        ) sub;

        -- Sleep interval to allow other queries to execute (e.g. 50ms)
        PERFORM pg_sleep(0.05);
      END LOOP;
    END;
    $$ LANGUAGE plpgsql;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Rollback Checklist:
  // - Revert index concurrently
  // - Drop column (requires lock timeouts)
  // - Data rollback: handled by dropping the column.
  
  // Safely drop index concurrently
  pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_identities_metadata_concurrent;');

  // Set timeouts for rollback DDL
  pgm.sql(`
    SET lock_timeout = '2s';
    SET statement_timeout = '5s';
  `);

  // Drop column
  pgm.dropColumn('identities', 'metadata');
}
