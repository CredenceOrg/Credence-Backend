# Database Migration Guardrails

This document outlines the standard operating procedures for creating, testing, and deploying database migrations safely. To prevent production outages, large data migrations must adhere to these guardrails.

## 1. Batching Large Data Migrations
When updating large tables, avoid full-table updates which lock rows and bloat the write-ahead log (WAL).
Instead, process updates in chunks (e.g., 1000 - 5000 rows) and incorporate a sleep interval between chunks to allow the database to process concurrent operations.

**Pattern:**
- Select a batch of primary keys using `LIMIT` and `OFFSET` or cursor-based pagination (e.g., `WHERE id > last_id ORDER BY id LIMIT 1000`).
- Apply the `UPDATE` to only those keys.
- Sleep for 50-100ms.
- Repeat until no more rows are returned.

## 2. Lock Timeout Settings
DDL operations (like adding columns or altering tables) require an exclusive lock. To prevent these operations from blocking other queries indefinitely (which causes a lock queue pileup), explicitly set timeouts before DDL commands.

- **`lock_timeout`**: Aborts the migration if it cannot acquire the lock within a short window (e.g., `'2s'`).
- **`statement_timeout`**: Ensures the statement itself does not take too long to execute (e.g., `'5s'`).

```sql
SET lock_timeout = '2s';
SET statement_timeout = '5s';
-- DDL statement
ALTER TABLE my_table ADD COLUMN new_col VARCHAR(50);
```
*(Remember to reset or manage these per transaction)*

## 3. Rollback Checklist
Every migration must include a reliable `down` method. Consider the following checklist:
- **Before Migration:** Can the application run correctly if the migration has been applied but the code isn't deployed yet? (Backward compatibility)
- **During Migration:** If the migration fails halfway (e.g., batch update fails on chunk 5), does the `down` migration safely handle partially updated state?
- **After Migration:** Can the application run correctly if the code is rolled back but the database retains the migration?
- **Reversion Strategy:** Ensure dropped columns are backed up or that data isn't permanently lost if a fast rollback is needed. For large state changes, consider double-writing or shadow writing first.

## 4. Concurrent Index Creation
Creating an index on a large table locks the table for writes by default. Always use `CONCURRENTLY` for tables in production.

```typescript
pgm.createIndex('users', 'email', { method: 'CONCURRENTLY' });
```
Note: `CONCURRENTLY` cannot be run inside a transaction block. You must disable transactions for that specific migration file or block (`export const config = { transaction: false }`).

## 5. Testing Against Production-Sized Datasets
Do not rely solely on empty local databases to test migration performance.
- Use a restored staging database or an obfuscated production snapshot.
- Verify that `lock_timeout` isn't triggered frequently by simulating production read/write load during testing.
- Check `EXPLAIN ANALYZE` for the migration's update queries to ensure they use indexes and don't trigger sequential scans on large tables.
