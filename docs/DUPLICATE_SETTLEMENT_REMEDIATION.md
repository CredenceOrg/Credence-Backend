# Duplicate Settlement Remediation

This document describes settlement idempotency via transaction_hash uniqueness and how to
detect and clean up pre-existing duplicate settlement records.

## Overview: Settlement Idempotency

Settlements are now idempotent on the on-chain `transaction_hash`. This means:

- **Each on-chain transaction can produce at most one settlement record**, regardless of how many times
  Horizon events are replayed or requests are retried
- The unique constraint on `transaction_hash` ensures this globally across all bonds
- Duplicate upsert attempts are automatically collapsed via `ON CONFLICT (transaction_hash)` semantics
- A metric (`settlement_duplicates_detected_total`) tracks how often duplicates are collapsed

### Example Scenario

1. Horizon withdrawal event for transaction `0xabc123def` triggers settlement creation for Bond A
2. Same event is replayed or request is retried → upsert attempt with same `transaction_hash`
3. Database ON CONFLICT clause automatically updates the existing record (or leaves it unchanged)
4. No new row is created
5. Metric is incremented to signal the duplicate was detected and handled

## 1. Detect pre-existing duplicates

**Before applying migration 006**, run this query to identify settlement rows that share the same
`transaction_hash` (across any bonds):

```sql
SELECT transaction_hash,
       COUNT(*)               AS duplicate_count,
       ARRAY_AGG(id ORDER BY created_at ASC) AS ids,
       ARRAY_AGG(bond_id ORDER BY created_at ASC) AS bond_ids
  FROM settlements
 GROUP BY transaction_hash
HAVING COUNT(*) > 1
 ORDER BY duplicate_count DESC;
```

If this query returns zero rows, no remediation is necessary and you can proceed directly to
applying migration 006.

## 2. Remove duplicates (keep earliest)

For each duplicate group, keep the row with the smallest `created_at` (first ingested) and delete
the rest:

```sql
DELETE FROM settlements
 WHERE id IN (
   SELECT id
     FROM (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY transaction_hash
                ORDER BY created_at ASC
              ) AS rn
         FROM settlements
     ) ranked
    WHERE rn > 1
 );
```

**Run this inside a transaction** so you can verify the affected row count before committing:

```sql
BEGIN;

-- Check how many rows will be removed
SELECT COUNT(*) AS rows_to_delete
  FROM settlements
 WHERE id IN (
   SELECT id
     FROM (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY transaction_hash
                ORDER BY created_at ASC
              ) AS rn
         FROM settlements
     ) ranked
    WHERE rn > 1
 );

-- If the count looks correct, run the DELETE (same subquery as above)
DELETE FROM settlements
 WHERE id IN (
   SELECT id
     FROM (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY transaction_hash
                ORDER BY created_at ASC
              ) AS rn
         FROM settlements
     ) ranked
    WHERE rn > 1
 );

COMMIT;
```

## 3. Apply the migration

After removing duplicates, apply the migration that adds the unique constraint on `transaction_hash`:

```bash
npm run migrate:dev
```

Or apply the raw SQL migration directly:

```bash
psql "$DATABASE_URL" -f src/migrations/006_settlement_tx_idempotency.ts
```

## 4. Monitoring duplicate detection

Once deployed, monitor the `settlement_duplicates_detected_total` Prometheus metric to track:
- How often replayed Horizon events are detected
- How often client retries result in idempotent handling

Query in Grafana or directly from Prometheus:

```promql
rate(settlement_duplicates_detected_total[1m])  # duplicates per minute
increase(settlement_duplicates_detected_total[1h])  # duplicates in last hour
```

## Post-Migration Validation

After applying migration 006, verify the constraint is in place:

```sql
SELECT constraint_name, constraint_type
  FROM information_schema.table_constraints
 WHERE table_name = 'settlements'
   AND constraint_type = 'UNIQUE';
```

You should see:
- `settlements_transaction_hash_unique` (new, on `transaction_hash`)

The old `settlements_bond_tx_unique` constraint (on `bond_id, transaction_hash`) should no longer appear.

## Security Considerations

### Conflict Semantics

The `ON CONFLICT (transaction_hash) DO UPDATE` clause:
- **Updates** `amount`, `status`, `settled_at` from the new insert attempt
- **Leaves unchanged** `bond_id` (preserves the bond from the first insert)
- **Updates** `updated_at` timestamp

This is intentional: a replayed event or retried request should not change which bond owns the settlement.
However, the status and amount may reflect a corrected or more recent state.

### Terminal Status Guard

If you require that a "settled" status cannot be overwritten by a "pending" status:
- Consider adding a `CASE` statement in the `ON CONFLICT DO UPDATE` clause
- Example: `status = CASE WHEN existing.status = 'settled' THEN existing.status ELSE EXCLUDED.status END`

Consult [VALIDATION.md](./VALIDATION.md) for settlement-specific validation rules.

## 4. Verify

Confirm the constraint is in place:

```sql
SELECT conname, contype
  FROM pg_constraint
 WHERE conrelid = 'settlements'::regclass
   AND conname  = 'settlements_bond_tx_unique';
```

Expected output:

```
         conname          | contype
--------------------------+---------
 settlements_bond_tx_unique | u
```

Re-run the duplicate detection query from step 1 to confirm zero
duplicates remain.
