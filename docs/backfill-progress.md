# Checking Backfill Progress

This document explains how operators and backend engineers can check the live status of any in-flight database backfill (such as large data migrations) and the next steps involved.

## Background

Large database migrations or data fixes often involve backfilling data in batches to prevent locking tables for extended periods. When a batch update, delete, or insert migration is running via our `batching.ts` utilities, the script automatically updates the PostgreSQL connection's `application_name` to reflect its live progress.

## How to Check Progress

You can observe the live progress of an ongoing backfill by querying the `pg_stat_activity` table from any PostgreSQL client (e.g., psql, DataGrip, pgAdmin).

Run the following query:

```sql
SELECT 
    pid, 
    usename, 
    state, 
    application_name, 
    query_start, 
    state_change
FROM pg_stat_activity 
WHERE application_name LIKE 'backfill%';
```

### Expected Output
The `application_name` column will report the current progress in real-time, for example:
`backfill my_table_name: 5000/100000 (5.0%)`

This shows:
- The target table being backfilled
- The number of rows processed so far
- The estimated total number of rows
- The percentage completed

## Next Steps

1. **Wait for Completion**: Backfills are designed to run without blocking read/write traffic. If the progress percentage is steadily increasing, allow the migration to complete naturally.
2. **Handle Failures**: If the `state` shows `idle in transaction` for an unusually long time or the connection drops:
   - Check the migration logs for any explicit errors.
   - The backfill is idempotent; you can safely restart the migration script, and it will resume where it left off.
3. **Monitor System Health**: While a backfill is running, ensure that `pg_stat_activity` does not show long queues of queries waiting on locks. If there is significant lock contention, refer to the [RUNBOOK.md](RUNBOOK.md) for how to adjust `DATABASE_LOCK_TIMEOUT_MS` or kill blocking processes if necessary.
