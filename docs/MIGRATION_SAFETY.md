# Migration Safety Guide

This guide provides best practices and safe patterns for database migrations in the Credence backend.

## Overview

The migration system includes built-in guardrails to prevent potentially dangerous operations and ensure smooth deployments. These include:

- **Preflight checks** that analyze migrations before execution
- **Runtime safeguards** that block unsafe operations
- **Online schema change patterns** for zero-downtime deployments

## Safe Migration Patterns

### 1. Adding Columns

**❌ Unsafe:**
```sql
ALTER TABLE users ADD COLUMN email VARCHAR(255) NOT NULL;
```

**✅ Safe:**
```typescript
// Step 1: Add nullable column
pgm.addColumn('users', 'email', { 
  type: 'varchar(255)', 
  null: true,
  comment: 'Added for email feature - will be NOT NULL after backfill'
})

// Step 2: Backfill data in application code or separate migration
// Step 3: Add NOT NULL constraint in follow-up migration
pgm.alterColumn('users', 'email', { notNull: true })
```

### 2. Creating Indexes

**❌ Unsafe (blocks writes):**
```typescript
pgm.createIndex('large_table', 'column_name')
```

**✅ Safe (online):**
```typescript
pgm.createIndex('large_table', 'column_name', { 
  method: 'CONCURRENTLY',
  name: 'idx_large_table_column'
})
```

### 3. Column Replacement

When replacing a column, use a multi-step approach:

```typescript
// Migration 1: Add new column
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('users', 'new_status', { 
    type: 'varchar(50)', 
    null: true,
    comment: 'Replacing old_status field'
  })
  
  // Create index on new column
  pgm.createIndex('users', 'new_status', { method: 'CONCURRENTLY' })
}

// Migration 2: Backfill data
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Backfill data from old column to new column
  pgm.sql(`
    UPDATE users 
    SET new_status = old_status 
    WHERE new_status IS NULL
  `)
}

// Migration 3: Switch references and drop old column
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add NOT NULL constraint to new column
  pgm.alterColumn('users', 'new_status', { notNull: true })
  
  // Update application code to use new column
  
  // Drop old column (after verifying app works with new column)
  pgm.dropColumn('users', 'old_status')
  
  // Rename new column if needed
  pgm.renameColumn('users', 'new_status', 'status')
}
```

### 4. Large Data Updates

**❌ Unsafe (locks table):**
```typescript
pgm.sql('UPDATE large_table SET status = "active" WHERE condition = true')
```

**✅ Safe (batched):**
```typescript
// Use application-level batching or pg-batch
// Or create a separate backfill script that runs in batches
pgm.sql(`
  UPDATE large_table 
  SET status = 'active' 
  WHERE id IN (
    SELECT id FROM large_table 
    WHERE condition = true 
    LIMIT 1000
  )
`)
```

## Migration Guardrails

### Preflight Checks

The system automatically checks for:

- **Blocking operations**: ADD COLUMN NOT NULL, CREATE UNIQUE INDEX, etc.
- **Long-running operations**: Large UPDATEs/DELETEs, index creation
- **Unsafe operations**: DROP TABLE, TRUNCATE, etc.

### Runtime Safeguards

- Automatic detection of potentially blocking operations
- Warnings for operations that might cause replication lag
- Enforcement of rollback strategies

## Using the Migration Linter

### Check all migrations:
```bash
npm run migrate:lint
```

### Check specific migration:
```bash
npm run migrate:lint -- --file migrations/001_add_email.ts
```

### Strict mode (warnings as errors):
```bash
npm run migrate:lint -- --strict
```

### Pre-flight check:
```bash
npm run migrate:preflight -- --file migrations/001_add_email.ts
```

## Deployment Best Practices

### 1. Staging Environment
Always test migrations in a staging environment with production-like data size.

### 2. Migration Timing
- Run potentially long-running migrations during low-traffic periods
- Use `CONCURRENTLY` for index creation on large tables
- Monitor database performance during migrations

### 3. Rollback Strategy
Every migration must have a working `down()` function that:
- Completely reverses the `up()` changes
- Handles edge cases (like partially completed operations)
- Has been tested in staging

### 4. Monitoring
- Monitor database locks during migration execution
- Watch replication lag in database clusters
- Set up alerts for long-running migrations

## Migration Checklist

Before creating a migration:

- [ ] Understand the impact on the application
- [ ] Have a rollback strategy
- [ ] Test with production-like data
- [ ] Consider online schema change patterns
- [ ] Add proper documentation

Before deploying:

- [ ] Run migration linter: `npm run migrate:lint -- --strict`
- [ ] Test in staging environment
- [ ] Verify rollback works
- [ ] Plan deployment timing
- [ ] Prepare monitoring

## Common Pitfalls

### 1. Adding NOT NULL columns without defaults
**Problem**: Blocks writes to the table
**Solution**: Add as NULL, backfill, then add constraint

### 2. Creating unique indexes on large tables
**Problem**: Blocks writes and can take hours
**Solution**: Use CONCURRENTLY or create non-unique index first

### 3. Large UPDATE/DELETE operations
**Problem**: Locks rows and causes replication lag
**Solution**: Use batching or application-level backfill

### 4. Missing rollback functions
**Problem**: Cannot easily undo changes
**Solution**: Always implement and test `down()` functions

## Emergency Procedures

If a migration fails:

1. **Stop the migration process**
2. **Check database locks**: `SELECT * FROM pg_locks WHERE NOT granted`
3. **Review error logs** for specific failure reason
4. **Run rollback** if safe: `npm run migrate:down`
5. **Contact database team** for complex issues

## Tools and Commands

```bash
# Create new migration with safety template
npm run migrate:create -- --name add_user_email --online

# Check migration safety
npm run migrate:lint

# Run pre-flight checks
npm run migrate:preflight -- --file migrations/001_add_email.ts

# Run migration with safety checks
npm run migrate:up

# Run migration allowing blocking ops (emergency only)
npm run migrate:up -- --allow-blocking

# Skip safety checks (emergency only)
npm run migrate:up -- --skip-preflight
```

## Additional Resources

- [PostgreSQL Online Schema Changes](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)
- [Zero Downtime Migrations](https://www.braintreepayments.com/blog/safe-operations-for-high-traffic-postgresql-databases)
- [Database Migration Best Practices](https://fly.io/blog/safe-database-migrations/)
