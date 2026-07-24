/**
 * Migration Lock Timeout Utilities
 * 
 * Provides utilities for managing database locks and timeouts
 * during long-running schema changes.
 */

import { MigrationBuilder } from 'node-pg-migrate'

export interface LockConfig {
  lockTimeout: number      // Time to wait for lock acquisition (ms)
  statementTimeout: number // Time limit for statement execution (ms)
  idleTimeout: number      // Time limit for idle transactions (ms)
  deadlockTimeout: number  // Deadlock detection timeout (ms)
}

export interface LockInfo {
  pid: number
  database: string
  relation: string
  mode: string
  granted: boolean
  query: string
  age: string
}

/**
 * Default timeout configurations for different operation types
 */
export const LOCK_TIMEOUTS = {
  // DDL operations (schema changes)
  DDL: {
    lockTimeout: 30000,      // 30 seconds
    statementTimeout: 300000, // 5 minutes
    idleTimeout: 60000,      // 1 minute
    deadlockTimeout: 1000    // 1 second
  },
  
  // Index creation (long-running)
  INDEX: {
    lockTimeout: 60000,      // 1 minute
    statementTimeout: 1800000, // 30 minutes
    idleTimeout: 300000,     // 5 minutes
    deadlockTimeout: 5000    // 5 seconds
  },
  
  // Data operations (updates, deletes)
  DATA: {
    lockTimeout: 10000,      // 10 seconds
    statementTimeout: 300000, // 5 minutes
    idleTimeout: 120000,     // 2 minutes
    deadlockTimeout: 2000    // 2 seconds
  },
  
  // Batch operations
  BATCH: {
    lockTimeout: 5000,       // 5 seconds
    statementTimeout: 60000,  // 1 minute per batch
    idleTimeout: 30000,       // 30 seconds
    deadlockTimeout: 1000     // 1 second
  }
}

/**
 * Apply timeout configuration for a migration
 */
export function applyTimeoutConfig(
  pgm: MigrationBuilder,
  config: Partial<LockConfig>
): void {
  const finalConfig = {
    lockTimeout: 30000,
    statementTimeout: 300000,
    idleTimeout: 60000,
    deadlockTimeout: 1000,
    ...config
  }

  pgm.sql(`SET LOCAL lock_timeout = ${finalConfig.lockTimeout}`)
  pgm.sql(`SET LOCAL statement_timeout = ${finalConfig.statementTimeout}`)
  pgm.sql(`SET LOCAL idle_in_transaction_session_timeout = ${finalConfig.idleTimeout}`)
  
  // Note: deadlock_timeout is a server parameter, cannot be set locally
  if (finalConfig.deadlockTimeout !== 1000) {
    pgm.sql(`-- deadlock_timeout should be set at server level: ${finalConfig.deadlockTimeout}ms`)
  }
}

/**
 * Apply predefined timeout configuration based on operation type
 */
export function applyTimeoutPreset(
  pgm: MigrationBuilder,
  operationType: keyof typeof LOCK_TIMEOUTS
): void {
  const config = LOCK_TIMEOUTS[operationType]
  applyTimeoutConfig(pgm, config)
}

/**
 * Check for existing locks that might block migration
 */
export function checkLockSafety(
  pgm: MigrationBuilder,
  tables: string[]
): Promise<LockInfo[]> {
  const tableList = tables.map(t => `'${t}'`).join(', ')
  
  const lockQuery = `
    SELECT 
      pg_locks.pid,
      pg_database.datname as database,
      pg_class.relname as relation,
      pg_locks.mode,
      pg_locks.granted,
      pg_stat_activity.query,
      now() - pg_stat_activity.query_start as age
    FROM pg_locks
    JOIN pg_database ON pg_locks.database = pg_database.oid
    JOIN pg_class ON pg_locks.relation = pg_class.oid
    JOIN pg_stat_activity ON pg_locks.pid = pg_stat_activity.pid
    WHERE pg_class.relname IN (${tableList})
    AND NOT pg_locks.granted
    ORDER BY pg_stat_activity.query_start
  `
  
  return pgm.sql(lockQuery) as Promise<LockInfo[]>
}

/**
 * Wait for locks to be released with timeout
 */
export async function waitForLocks(
  pgm: MigrationBuilder,
  tables: string[],
  maxWaitTime: number = 60000 // 1 minute
): Promise<boolean> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < maxWaitTime) {
    const blockingLocks = await checkLockSafety(pgm, tables)
    
    if (blockingLocks.length === 0) {
      return true // No blocking locks
    }
    
    // Log blocking locks
    pgm.sql(`
      DO $$
      BEGIN
        RAISE NOTICE 'Waiting for % blocking locks on tables: %', 
          '${blockingLocks.length}', '${tables.join(', ')}';
      END $$;
    `)
    
    // Wait 5 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
  
  return false // Timeout reached
}

/**
 * Create a lock-aware migration wrapper
 */
export async function withLockSafety<T>(
  pgm: MigrationBuilder,
  tables: string[],
  operation: () => Promise<T>,
  lockConfig: Partial<LockConfig> = {}
): Promise<T> {
  // Apply timeout configuration
  applyTimeoutConfig(pgm, lockConfig)
  
  // Check for existing locks
  const blockingLocks = await checkLockSafety(pgm, tables)
  
  if (blockingLocks.length > 0) {
    pgm.sql(`
      DO $$
      BEGIN
        RAISE WARNING 'Found % blocking locks before migration', '${blockingLocks.length}';
        RAISE WARNING 'Lock details: %', 
          array_agg(
            format('PID: %s, Table: %s, Mode: %s, Age: %s', 
              pid, relation, mode, age)
          );
      END $$;
    `)
    
    // Wait for locks to be released
    const lockReleased = await waitForLocks(pgm, tables, lockConfig.lockTimeout)
    
    if (!lockReleased) {
      throw new Error(`Cannot acquire locks on tables: ${tables.join(', ')} after timeout`)
    }
  }
  
  // Execute the operation
  try {
    return await operation()
  } catch (error) {
    // Check if error is lock-related
    if (error instanceof Error && error.message.includes('lock')) {
      pgm.sql(`
        DO $$
        BEGIN
          RAISE EXCEPTION 'Migration failed due to lock contention: %', '${error.message}';
        END $$;
      `)
    }
    throw error
  }
}

/**
 * Monitor lock activity during migration
 */
export function monitorLocks(pgm: MigrationBuilder, intervalSeconds: number = 10): void {
  pgm.sql(`
    DO $$
    DECLARE
        start_time timestamp := now();
        monitor_interval interval := '${intervalSeconds} seconds'::interval;
    BEGIN
        -- Start lock monitoring
        RAISE NOTICE 'Starting lock monitoring every % seconds', '${intervalSeconds}';
        
        -- This would typically be handled by application-level monitoring
        -- Here we just set up the infrastructure for tracking
        
        CREATE TEMP TABLE IF NOT EXISTS migration_lock_log (
            timestamp timestamp DEFAULT now(),
            pid integer,
            relation text,
            mode text,
            granted boolean,
            query text
        );
        
        -- Log current locks
        INSERT INTO migration_lock_log (pid, relation, mode, granted, query)
        SELECT 
            pg_locks.pid,
            pg_class.relname,
            pg_locks.mode,
            pg_locks.granted,
            pg_stat_activity.query
        FROM pg_locks
        JOIN pg_class ON pg_locks.relation = pg_class.oid
        JOIN pg_stat_activity ON pg_locks.pid = pg_stat_activity.pid
        WHERE pg_locks.datname = current_database();
        
        RAISE NOTICE 'Logged % current locks', (SELECT COUNT(*) FROM migration_lock_log);
    END $$;
  `)
}

/**
 * Get lock statistics for monitoring
 */
export function getLockStats(pgm: MigrationBuilder): Promise<any> {
  return pgm.sql(`
    SELECT 
      mode,
      granted,
      COUNT(*) as lock_count,
      array_agg(DISTINCT pg_class.relname) as tables
    FROM pg_locks
    JOIN pg_class ON pg_locks.relation = pg_class.oid
    WHERE pg_locks.datname = current_database()
    GROUP BY mode, granted
    ORDER BY granted DESC, lock_count DESC
  `) as Promise<any>
}

/**
 * Kill blocking sessions (emergency use only)
 */
export function killBlockingSessions(pgm: MigrationBuilder, tables: string[]): void {
  pgm.sql(`
    DO $$
    DECLARE
        blocking_pid integer;
        blocking_query text;
    BEGIN
        -- Find blocking sessions
        SELECT pg_locks.pid, pg_stat_activity.query
        INTO blocking_pid, blocking_query
        FROM pg_locks
        JOIN pg_stat_activity ON pg_locks.pid = pg_stat_activity.pid
        JOIN pg_class ON pg_locks.relation = pg_class.oid
        WHERE pg_class.relname IN ('${tables.join("','")}')
        AND NOT pg_locks.granted
        AND pg_locks.pid != pg_backend_pid()
        LIMIT 1;
        
        IF blocking_pid IS NOT NULL THEN
            RAISE WARNING 'Terminating blocking session %: %', blocking_pid, blocking_query;
            EXECUTE 'SELECT pg_terminate_backend(' || blocking_pid || ')';
        ELSE
            RAISE NOTICE 'No blocking sessions found';
        END IF;
    END $$;
  `)
}

/**
 * Create a safe migration wrapper with comprehensive lock management
 */
export function createSafeMigration(
  pgm: MigrationBuilder,
  migrationName: string,
  affectedTables: string[],
  operationType: keyof typeof LOCK_TIMEOUTS = 'DDL',
  operation: () => Promise<void>
): Promise<void> {
  return withLockSafety(pgm, affectedTables, async () => {
    // Apply timeout preset
    applyTimeoutPreset(pgm, operationType)
    
    // Start monitoring
    monitorLocks(pgm)
    
    // Log migration start
    pgm.sql(`
      DO $$
      BEGIN
        RAISE NOTICE 'Starting migration: %', '${migrationName}';
        RAISE NOTICE 'Affected tables: %', '${affectedTables.join(', ')}';
        RAISE NOTICE 'Operation type: %', '${operationType}';
      END $$;
    `)
    
    // Execute the operation
    await operation()
    
    // Log completion
    pgm.sql(`
      DO $$
      BEGIN
        RAISE NOTICE 'Migration completed successfully: %', '${migrationName}';
      END $$;
    `)
    
    // Get final lock stats
    const stats = getLockStats(pgm)
    pgm.sql(`
      DO $$
      BEGIN
        RAISE NOTICE 'Final lock statistics: %', '${JSON.stringify(stats)}';
      END $$;
    `)
  }, LOCK_TIMEOUTS[operationType])
}
