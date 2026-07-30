# Checking Backfill Progress

This document explains how operators and backend engineers can check the live
status of any in-flight database backfill, and how durable progress markers
allow long-running jobs to resume after a crash or process restart.

## Background

Large database migrations or data fixes often involve backfilling data in
batches to prevent locking tables for extended periods. When a batch update,
delete, or insert migration is running via our `batching.ts` utilities, the
script automatically updates the PostgreSQL connection's `application_name` to
reflect its live progress.

For application-level backfill jobs (Node workers / scripts), use the
**durable progress markers** in `backfill_progress` so work survives restarts.

## Durable progress markers (resumable backfills)

Long-running backfills should use `ResumableBackfillRunner` from
`src/jobs/backfill/`. After each successfully committed batch the runner
persists a checkpoint to the `backfill_progress` table:

| Column | Purpose |
| --- | --- |
| `job_name` | Stable unique job id (primary key) |
| `cursor_value` | Opaque last-committed watermark used to resume |
| `rows_processed` | Cumulative rows checkpointed so far |
| `total_rows` | Optional estimated total for % complete |
| `status` | `pending` \| `running` \| `completed` \| `failed` |
| `last_error` | Truncated error message when `status = failed` |
| `metadata` | Optional JSON context for operators |

On restart, the runner loads the marker and continues from `cursor_value`
instead of reprocessing from the beginning. Batch processors must be
idempotent for the chosen cursor scheme.

### Example

```typescript
import { runResumableBackfill } from '../jobs/backfill/index.js'

await runResumableBackfill(
  pool,
  async (cursor, batchSize) => {
    // Fetch next batch after `cursor`, apply idempotent updates, commit.
    const rows = await fetchBatchAfter(cursor, batchSize)
    if (rows.length === 0) {
      return { nextCursor: cursor, processedCount: 0, done: true }
    }
    await applyUpdates(rows)
    return {
      nextCursor: rows[rows.length - 1].id,
      processedCount: rows.length,
      done: rows.length < batchSize,
    }
  },
  { jobName: 'tenant_id_backfill', batchSize: 500 },
)
```

### Inspecting markers in SQL

```sql
SELECT job_name, status, cursor_value, rows_processed, total_rows,
       last_error, updated_at
FROM backfill_progress
ORDER BY updated_at DESC;
```

`job_name` is validated before write (`[a-zA-Z0-9_.:/-]{1,128}`) and cursors
reject control characters — values are always parameterized to prevent SQL
injection.

## Live session progress (`application_name`)

You can also observe migration-style backfills that set `application_name` by
querying `pg_stat_activity`:

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
2. **Handle Failures**: If the process crashes mid-run:
   - Check `backfill_progress` for `status = 'failed'` and `last_error`.
   - Re-run the same job name; it resumes from the last committed `cursor_value`.
   - For migration `application_name` sessions, check logs and restart the idempotent script.
3. **Monitor System Health**: While a backfill is running, ensure that `pg_stat_activity` does not show long queues of queries waiting on locks. If there is significant lock contention, refer to the [RUNBOOK.md](RUNBOOK.md) for how to adjust `DATABASE_LOCK_TIMEOUT_MS` or kill blocking processes if necessary.
