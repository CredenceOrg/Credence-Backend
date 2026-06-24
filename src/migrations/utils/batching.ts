/**
 * Migration Batching Utilities
 * 
 * Provides safe batching patterns for large database operations
 * to prevent locks and reduce replication lag.
 */

import { MigrationBuilder } from 'node-pg-migrate'

export interface BatchConfig {
  batchSize: number
  timeoutMs?: number
  commitInterval?: number
  progressCallback?: (processed: number, total: number) => void
}

export interface BatchResult {
  totalProcessed: number
  batchesProcessed: number
  duration: number
  errors: string[]
}

/**
 * Default configuration for batching operations
 */
const DEFAULT_BATCH_CONFIG: BatchConfig = {
  batchSize: 1000,
  timeoutMs: 300000, // 5 minutes
  commitInterval: 1, // Commit every batch
}

/**
 * Safely update rows in batches to prevent long-running locks
 */
export async function batchUpdate(
  pgm: MigrationBuilder,
  tableName: string,
  updateClause: string,
  whereClause: string,
  config: Partial<BatchConfig> = {}
): Promise<BatchResult> {
  const finalConfig = { ...DEFAULT_BATCH_CONFIG, ...config }
  const startTime = Date.now()
  const errors: string[] = []
  let totalProcessed = 0
  let batchesProcessed = 0

  try {
    // Set timeout for this operation
    if (finalConfig.timeoutMs) {
      pgm.sql(`SET LOCAL statement_timeout = ${finalConfig.timeoutMs}`)
    }

    const batchQuery = `
      DO $$
      DECLARE
          batch_count INT := 0;
          remaining INT;
          total_count INT := 0;
          batch_size INT := ${finalConfig.batchSize};
      BEGIN
          -- Get total count for progress tracking
          EXECUTE 'SELECT COUNT(*) FROM ${tableName} WHERE ${whereClause}' INTO total_count;
          
          -- Initialize progress tracking
          RAISE NOTICE 'Starting batch update: % rows to process', total_count;
          
          remaining := total_count;
          
          WHILE remaining > 0 LOOP
              -- Process one batch
              EXECUTE '
                  UPDATE ${tableName} 
                  SET ${updateClause} 
                  WHERE ctid IN (
                      SELECT ctid FROM ${tableName} 
                      WHERE ${whereClause} 
                      LIMIT ' || batch_size || '
                  )';
              
              GET DIAGNOSTICS batch_count = ROW_COUNT;
              remaining := remaining - batch_count;
              total_processed := total_processed + batch_count;
              batches_processed := batches_processed + 1;
              
              -- Progress notification
              RAISE NOTICE 'Batch %: % rows processed, % remaining', 
                  batches_processed, batch_count, remaining;
              
              -- Commit if configured
              IF batches_processed % ${finalConfig.commitInterval} = 0 THEN
                  COMMIT;
                  RAISE NOTICE 'Committed after % batches', batches_processed;
              END IF;
              
              -- Safety check to prevent infinite loops
              IF batch_count = 0 THEN
                  RAISE NOTICE 'No rows processed in batch, exiting';
                  EXIT;
              END IF;
          END LOOP;
          
          -- Final commit if needed
          IF batches_processed % ${finalConfig.commitInterval} != 0 THEN
              COMMIT;
          END IF;
          
          RAISE NOTICE 'Batch update completed: % batches, % rows total', 
              batches_processed, total_processed;
      END $$;
    `

    pgm.sql(batchQuery)

    // Get results from the batch operation
    const result = pgm.sql(`
      SELECT 
        ${totalProcessed} as total_processed,
        ${batchesProcessed} as batches_processed,
        EXTRACT(EPOCH FROM (NOW() - '${new Date(startTime).toISOString()}'::timestamp)) * 1000 as duration
    `)

    return {
      totalProcessed,
      batchesProcessed,
      duration: Date.now() - startTime,
      errors
    }

  } catch (error) {
    errors.push(`Batch update failed: ${error}`)
    throw error
  }
}

/**
 * Safely delete rows in batches
 */
export async function batchDelete(
  pgm: MigrationBuilder,
  tableName: string,
  whereClause: string,
  config: Partial<BatchConfig> = {}
): Promise<BatchResult> {
  const finalConfig = { ...DEFAULT_BATCH_CONFIG, ...config }
  const startTime = Date.now()
  const errors: string[] = []
  let totalProcessed = 0
  let batchesProcessed = 0

  try {
    if (finalConfig.timeoutMs) {
      pgm.sql(`SET LOCAL statement_timeout = ${finalConfig.timeoutMs}`)
    }

    const batchQuery = `
      DO $$
      DECLARE
          batch_count INT := 0;
          remaining INT;
          total_count INT := 0;
          batch_size INT := ${finalConfig.batchSize};
      BEGIN
          -- Get total count
          EXECUTE 'SELECT COUNT(*) FROM ${tableName} WHERE ${whereClause}' INTO total_count;
          
          RAISE NOTICE 'Starting batch delete: % rows to delete', total_count;
          remaining := total_count;
          
          WHILE remaining > 0 LOOP
              -- Delete one batch
              EXECUTE '
                  DELETE FROM ${tableName} 
                  WHERE ctid IN (
                      SELECT ctid FROM ${tableName} 
                      WHERE ${whereClause} 
                      LIMIT ' || batch_size || '
                  )';
              
              GET DIAGNOSTICS batch_count = ROW_COUNT;
              remaining := remaining - batch_count;
              total_processed := total_processed + batch_count;
              batches_processed := batches_processed + 1;
              
              RAISE NOTICE 'Batch %: % rows deleted, % remaining', 
                  batches_processed, batch_count, remaining;
              
              -- Commit to free up space
              COMMIT;
              
              -- Safety check
              IF batch_count = 0 THEN
                  RAISE NOTICE 'No rows deleted in batch, exiting';
                  EXIT;
              END IF;
              
              -- Pause briefly to allow other operations
              PERFORM pg_sleep(0.1);
          END LOOP;
          
          RAISE NOTICE 'Batch delete completed: % batches, % rows total', 
              batches_processed, total_processed;
      END $$;
    `

    pgm.sql(batchQuery)

    return {
      totalProcessed,
      batchesProcessed,
      duration: Date.now() - startTime,
      errors
    }

  } catch (error) {
    errors.push(`Batch delete failed: ${error}`)
    throw error
  }
}

/**
 * Safely insert data in batches from a SELECT query
 */
export async function batchInsertSelect(
  pgm: MigrationBuilder,
  targetTable: string,
  targetColumns: string[],
  selectQuery: string,
  config: Partial<BatchConfig> = {}
): Promise<BatchResult> {
  const finalConfig = { ...DEFAULT_BATCH_CONFIG, ...config }
  const startTime = Date.now()
  const errors: string[] = []
  let totalProcessed = 0
  let batchesProcessed = 0

  try {
    if (finalConfig.timeoutMs) {
      pgm.sql(`SET LOCAL statement_timeout = ${finalConfig.timeoutMs}`)
    }

    const columnList = targetColumns.join(', ')
    const batchQuery = `
      DO $$
      DECLARE
          batch_count INT := 0;
          remaining INT;
          total_count INT := 0;
          batch_size INT := ${finalConfig.batchSize};
      BEGIN
          -- Get total count from source
          EXECUTE 'SELECT COUNT(*) FROM (' || '${selectQuery}' || ') AS source' INTO total_count;
          
          RAISE NOTICE 'Starting batch insert: % rows to insert', total_count;
          remaining := total_count;
          
          WHILE remaining > 0 LOOP
              -- Insert one batch
              EXECUTE '
                  INSERT INTO ${targetTable} (${columnList})
                  SELECT * FROM (
                      ${selectQuery}
                      LIMIT ' || batch_size || '
                  ) AS batch_data';
              
              GET DIAGNOSTICS batch_count = ROW_COUNT;
              remaining := remaining - batch_count;
              total_processed := total_processed + batch_count;
              batches_processed := batches_processed + 1;
              
              RAISE NOTICE 'Batch %: % rows inserted, % remaining', 
                  batches_processed, batch_count, remaining;
              
              -- Commit periodically
              IF batches_processed % ${finalConfig.commitInterval} = 0 THEN
                  COMMIT;
              END IF;
              
              -- Safety check
              IF batch_count = 0 THEN
                  RAISE NOTICE 'No rows inserted in batch, exiting';
                  EXIT;
              END IF;
          END LOOP;
          
          -- Final commit
          IF batches_processed % ${finalConfig.commitInterval} != 0 THEN
              COMMIT;
          END IF;
          
          RAISE NOTICE 'Batch insert completed: % batches, % rows total', 
              batches_processed, total_processed;
      END $$;
    `

    pgm.sql(batchQuery)

    return {
      totalProcessed,
      batchesProcessed,
      duration: Date.now() - startTime,
      errors
    }

  } catch (error) {
    errors.push(`Batch insert failed: ${error}`)
    throw error
  }
}

/**
 * Create a backfill migration for adding and populating a new column
 */
export async function createBackfillMigration(
  pgm: MigrationBuilder,
  tableName: string,
  columnName: string,
  columnDefinition: any,
  backfillQuery: string,
  config: Partial<BatchConfig> = {}
): Promise<void> {
  // Step 1: Add nullable column
  pgm.addColumn(tableName, columnName, {
    ...columnDefinition,
    null: true,
    comment: `Backfill column - populated by migration`
  })

  // Step 2: Create index if needed
  if (columnDefinition.index) {
    pgm.createIndex(tableName, columnName, {
      method: 'CONCURRENTLY',
      name: `idx_${tableName}_${columnName}_backfill`
    })
  }

  // Step 3: Backfill data in batches
  await batchUpdate(pgm, tableName, `${columnName} = (${backfillQuery})`, 
    `${columnName} IS NULL`, config)

  // Step 4: Add NOT NULL constraint if required
  if (columnDefinition.notNull) {
    pgm.alterColumn(tableName, columnName, { notNull: true })
  }
}

/**
 * Estimate operation complexity to suggest appropriate batching
 */
export function estimateBatchSize(
  operationType: 'UPDATE' | 'DELETE' | 'INSERT',
  estimatedRows: number,
  tableSize: 'small' | 'medium' | 'large' = 'medium'
): number {
  const baseSizes = {
    small: { UPDATE: 5000, DELETE: 2000, INSERT: 10000 },
    medium: { UPDATE: 1000, DELETE: 500, INSERT: 5000 },
    large: { UPDATE: 500, DELETE: 200, INSERT: 2000 }
  }

  const baseSize = baseSizes[tableSize][operationType]
  
  // Adjust based on estimated total rows
  if (estimatedRows > 1000000) {
    return Math.min(baseSize, 200)
  } else if (estimatedRows > 100000) {
    return Math.min(baseSize, 500)
  } else if (estimatedRows > 10000) {
    return baseSize
  } else {
    return Math.min(baseSize * 2, 10000)
  }
}
