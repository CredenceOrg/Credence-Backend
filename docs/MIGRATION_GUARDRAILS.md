# Migration Guardrails for Long-Running Schema Changes

This guide provides comprehensive guardrails and best practices for handling long-running database migrations, including batching strategies, lock timeout management, and rollback procedures.

## Overview

Long-running schema changes require special handling to ensure:
- **Zero downtime** during deployments
- **Database stability** under load
- **Safe rollback** capabilities
- **Predictable execution** times

## Critical Guardrails

### 1. Batching Strategies

#### When to Use Batching
- Table updates affecting >10,000 rows
- Index creation on tables >1M rows
- Column additions with backfill operations
- Data migration/cleanup operations

#### Safe Batching Patterns

**✅ Recommended: Application-level Batching**
```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  // For very large tables, use application-level backfill
  // This migration only sets up the structure
  pgm.addColumn('users', 'email_verified', { 
    type: 'boolean', 
    null: true,
    default: false,
    comment: 'Email verification status - will be backfilled'
  })
}

// Separate backfill script runs in batches
// See: scripts/backfill-email-verified.ts
```

**✅ Recommended: SQL-based Batching**
```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Process in batches of 1000 rows
  pgm.sql(`
    DO $$
    DECLARE
        batch_size INT := 1000;
        processed INT := 0;
        total INT;
    BEGIN
        SELECT COUNT(*) INTO total FROM users WHERE email IS NOT NULL AND email_verified IS NULL;
        
        WHILE processed < total LOOP
            UPDATE users 
            SET email_verified = true 
            WHERE id IN (
                SELECT id FROM users 
                WHERE email IS NOT NULL AND email_verified IS NULL 
                LIMIT batch_size
            );
            
            processed := processed + batch_size;
            -- Commit every batch to avoid long transactions
            COMMIT;
        END LOOP;
    END $$;
  `)
}
```

**❌ Avoid: Single Large Transaction**
```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  // DANGEROUS: Updates millions of rows in one transaction
  pgm.sql('UPDATE users SET email_verified = true WHERE email IS NOT NULL')
}
```

### 2. Lock Timeout Management

#### Default Timeout Configuration
```typescript
// In migration config
const migrationConfig = {
  lockTimeout: 30000,        // 30 seconds for DDL operations
  statementTimeout: 300000,  // 5 minutes for data operations
  idleInTransactionSessionTimeout: 60000, // 1 minute
}
```

#### Operation-Specific Timeouts

**Index Creation:**
```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('SET LOCAL statement_timeout = 1800000') // 30 minutes
  
  pgm.createIndex('large_table', 'column_name', { 
    method: 'CONCURRENTLY',
    name: 'idx_large_table_column_concurrent'
  })
}
```

**Data Backfill:**
```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('SET LOCAL statement_timeout = 300000') // 5 minutes per batch
  
  pgm.sql(`
    UPDATE users 
    SET email_verified = true 
    WHERE id IN (
      SELECT id FROM users 
      WHERE email IS NOT NULL AND email_verified IS NULL 
      LIMIT 10000
    )
  `)
}
```

#### Lock Detection and Monitoring
```typescript
// Add to migration preflight checks
export function checkLockSafety(migrationContent: string): LockSafetyResult {
  const hasLongRunningDDL = /CREATE\s+INDEX.*CONCURRENTLY/i.test(migrationContent)
  const hasLargeUpdate = /UPDATE.*SET.*WHERE.*LIMIT\s+[0-9]{4,}/i.test(migrationContent)
  
  return {
    requiresMonitoring: hasLongRunningDDL || hasLargeUpdate,
    suggestedTimeout: hasLongRunningDDL ? 1800000 : 300000,
    lockRiskLevel: calculateLockRisk(migrationContent)
  }
}
```

### 3. Rollback Checklist

#### Pre-Deployment Rollback Verification
```markdown
## Rollback Checklist - [Migration Name]

### Before Deployment
- [ ] Down migration tested in staging
- [ ] Rollback script reviewed by DB team
- [ ] Data backup strategy confirmed
- [ ] Application compatibility verified
- [ ] Monitoring alerts configured

### During Deployment
- [ ] Database performance monitored
- [ ] Lock activity watched
- [ ] Replication lag checked
- [ ] Application error rates tracked

### Post-Deployment
- [ ] Migration marked as complete
- [ ] Monitoring continued for 24 hours
- [ ] Rollback window documented
- [ ] Success criteria met
```

#### Safe Rollback Patterns

**Column Addition Rollback:**
```typescript
export async function down(pgm: MigrationBuilder): Promise<void> {
  // Safe: Drop newly added column
  pgm.dropColumn('users', 'email_verified')
}
```

**Index Creation Rollback:**
```typescript
export async function down(pgm: MigrationBuilder): Promise<void> {
  // Safe: Drop concurrently created index
  pgm.dropIndex('large_table', 'column_name', { 
    name: 'idx_large_table_column_concurrent'
  })
}
```

**Data Migration Rollback:**
```typescript
export async function down(pgm: MigrationBuilder): Promise<void> {
  // Complex: May need to restore from backup
  // Consider using audit logs or timestamp-based restoration
  pgm.sql(`
    UPDATE users 
    SET email_verified = NULL 
    WHERE email_verified = true 
    AND updated_at > '2024-01-01'::timestamp
  `)
}
```

## Migration Categories and Guardrails

### Category 1: Safe (Low Risk)
- Adding nullable columns
- Creating non-unique indexes with CONCURRENTLY
- Adding new tables
- Creating constraints without validation

**Guardrails:**
- Standard timeout (30 seconds)
- Basic preflight checks
- No special monitoring required

### Category 2: Medium Risk
- Adding NOT NULL columns (requires backfill)
- Creating unique indexes
- Column type changes
- Large data updates (>10K rows)

**Guardrails:**
- Extended timeout (5 minutes)
- Batching required for data operations
- Performance monitoring
- Rollback script mandatory

### Category 3: High Risk
- Table restructuring
- Large table index creation (>1M rows)
- Primary key changes
- Data migration between tables

**Guardrails:**
- Extended timeout (30+ minutes)
- DB team approval required
- Comprehensive monitoring
- Backup verification
- Maintenance window recommended

## Implementation Guidelines

### 1. Migration Structure Template

```typescript
/**
 * Migration: [Name]
 * 
 * Category: [Safe/Medium/High Risk]
 * Estimated Runtime: [X minutes/hours]
 * Rollback Complexity: [Low/Medium/High]
 * 
 * Dependencies: [List any prerequisite migrations]
 * Impact: [Tables affected, rows estimated]
 * 
 * Monitoring Required: [Yes/No]
 * DB Team Approval: [Yes/No]
 * 
 * Created: [Timestamp]
 * Author: [Name]
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Set appropriate timeouts
  pgm.sql('SET LOCAL statement_timeout = 300000')
  
  // Implementation here
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Rollback implementation
}
```

### 2. Batching Utilities

```typescript
// utils/migration-batching.ts
export async function batchUpdate(
  pgm: MigrationBuilder,
  tableName: string,
  updateClause: string,
  whereClause: string,
  batchSize: number = 1000
): Promise<void> {
  const batchQuery = `
    DO $$
    DECLARE
        batch_count INT := 0;
        remaining INT;
    BEGIN
        SELECT COUNT(*) INTO remaining FROM ${tableName} WHERE ${whereClause};
        
        WHILE remaining > 0 LOOP
            UPDATE ${tableName} SET ${updateClause} 
            WHERE ctid IN (
                SELECT ctid FROM ${tableName} 
                WHERE ${whereClause} 
                LIMIT ${batchSize}
            );
            
            GET DIAGNOSTICS batch_count = ROW_COUNT;
            remaining := remaining - batch_count;
            
            -- Avoid long transactions
            IF batch_count > 0 THEN
                COMMIT;
            END IF;
        END LOOP;
    END $$;
  `
  
  pgm.sql(batchQuery)
}
```

### 3. Monitoring Integration

```typescript
// utils/migration-monitoring.ts
export function logMigrationProgress(
  migrationName: string,
  step: string,
  affectedRows?: number
): void {
  console.log(`[MIGRATION] ${migrationName}: ${step}`, 
    affectedRows ? `(${affectedRows} rows)` : '')
  
  // Send to monitoring system
  if (process.env.NODE_ENV === 'production') {
    // Integration with your monitoring system
  }
}

export function checkDatabaseHealth(): Promise<boolean> {
  // Check replication lag, lock count, etc.
  return Promise.resolve(true)
}
```

## Testing and Validation

### 1. Staging Environment Requirements
- Production-like data volume (at least 10% of prod)
- Same database version and configuration
- Load testing during migration
- Performance baseline comparison

### 2. Automated Tests
```typescript
// tests/migration-guardrails.test.ts
describe('Migration Guardrails', () => {
  test('should detect unsafe operations', () => {
    const migration = `
      CREATE INDEX CONCURRENTLY idx_users_email ON users(email)
      UPDATE users SET status = 'active' WHERE status = 'pending'
    `
    
    const result = analyzeMigration(migration)
    expect(result.issues).toHaveLength(1) // UPDATE without batching
    expect(result.warnings).toHaveLength(1) // Long-running index
  })
  
  test('should validate rollback safety', () => {
    const migration = readFileSync('001_add_email.ts', 'utf-8')
    const rollback = extractDownFunction(migration)
    
    expect(rollback).toBeDefined()
    expect(rollback).not.toContain('DROP TABLE') // Unless intentional
  })
})
```

### 3. Performance Benchmarks
- Index creation: < 30 minutes per 10M rows
- Data backfill: < 5 minutes per 100K rows
- Lock acquisition: < 1 second
- Replication lag: < 100ms

## Emergency Procedures

### 1. Migration Failure Response
```bash
# 1. Check current status
npm run migrate:status

# 2. Identify blocking locks
psql -c "SELECT * FROM pg_locks WHERE NOT granted"

# 3. Check long-running queries
psql -c "SELECT pid, now() - pg_stat_activity.query_start AS duration, query 
         FROM pg_stat_activity WHERE state = 'active' 
         AND now() - pg_stat_activity.query_start > interval '5 minutes'"

# 4. Emergency rollback (if safe)
npm run migrate:down -- --force

# 5. Contact DB team with details
# - Migration name and timestamp
# - Error messages
# - Database metrics
# - Application impact
```

### 2. Lock Timeout Resolution
```sql
-- Identify blocking process
SELECT 
  blocked_locks.pid AS blocked_pid,
  blocked_activity.usename AS blocked_user,
  blocking_locks.pid AS blocking_pid,
  blocking_activity.usename AS blocking_user,
  blocked_activity.query AS blocked_statement,
  blocking_activity.query AS current_statement_in_blocking_process
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

## Tools and Commands

### Enhanced Migration Commands
```bash
# Create migration with guardrails template
npm run migrate:create -- --name add_user_verification --template=guardrails

# Run with extended monitoring
npm run migrate:up -- --monitor --timeout=1800000

# Dry run with impact analysis
npm run migrate:preflight -- --analyze --estimate-rows

# Batch validation
npm run migrate:validate -- --batch-size=1000

# Rollback simulation
npm run migrate:simulate-down -- --migration=001_add_email
```

### Monitoring Commands
```bash
# Migration progress
npm run migrate:status -- --detailed

# Database health during migration
npm run db:health -- --during-migration

# Lock monitoring
npm run db:locks -- --watch

# Performance impact
npm run db:performance -- --baseline-compare
```

## Best Practices Summary

1. **Always use CONCURRENTLY for indexes on large tables**
2. **Batch operations affecting more than 10,000 rows**
3. **Set appropriate timeouts for each operation type**
4. **Test rollbacks in staging before production**
5. **Monitor database performance during migrations**
6. **Document dependencies and impact**
7. **Use maintenance windows for high-risk changes**
8. **Have emergency rollback procedures ready**
9. **Validate with production-like data volumes**
10. **Get DB team approval for high-risk migrations**

## References

- [PostgreSQL Lock Monitoring](https://www.postgresql.org/docs/current/view-pg-locks.html)
- [Online Schema Change Best Practices](https://www.braintreepayments.com/blog/safe-operations-for-high-traffic-postgresql-databases)
- [Zero Downtime Deployments](https://fly.io/blog/safe-database-migrations/)
- [Database Migration Patterns](https://tech.ebayinc.com/engineering/zero-downtime-schema-migration/)
