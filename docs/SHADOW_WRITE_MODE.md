# Shadow Write Mode for Pipeline Migration

## Overview

Shadow write mode is a feature that enables safe validation and gradual migration of the settlement pipeline. When enabled, writes go to **both old and new pipelines simultaneously**, and the results are compared in metrics to identify any behavioral differences before completing the migration.

## Why Shadow Write Mode?

The current architecture forces a binary choice: either use the old pipeline **or** the new pipeline, but not both. This creates a testing gap—how do we verify the new pipeline produces identical results before fully migrating?

Shadow write mode eliminates this gap by:

- **Writing to both pipelines** in parallel
- **Comparing results** automatically
- **Recording discrepancies** in Prometheus metrics
- **Allowing gradual rollout** with confidence

## Prerequisites

Both conditions must be true for shadow write mode to activate:

1. `NEW_PIPELINE=true` – The new pipeline must be enabled
2. `SHADOW_WRITE_MODE=true` – Shadow write validation mode must be enabled

If only `NEW_PIPELINE=true` is set, the system uses the new pipeline exclusively (non-shadow path).

## How It Works

### Write Phase

When a settlement is written (`upsertSettlementStatus`), the settlement service:

1. Checks if shadow write mode is enabled (`SHADOW_WRITE_MODE && NEW_PIPELINE`)
2. If yes, executes `executeShadowWrite()` which:
   - Calls `oldRepository.upsert(input)` in parallel
   - Calls `newRepository.upsert(input)` in parallel
   - Captures both results and any errors
3. Returns the **old pipeline result** to the caller (primary)
4. Asynchronously compares results and records metrics

### Comparison Phase

The `diffAndRecordShadowWrites()` function compares:

| Check | Metric Recorded | Severity |
|-------|-----------------|----------|
| Old pipeline failed, new succeeded | `error_mismatch` | Critical |
| Old succeeded, new pipeline failed | `error_mismatch` | Critical |
| Status differs (e.g., settled vs pending) | `status_mismatch` | High |
| Amount, bondId, or hash differs | `data_mismatch` | High |
| Duplicate detection differs | `data_mismatch` | High |
| Both pipelines failed consistently | _(no metric recorded)_ | OK |
| Both pipelines succeeded identically | _(no metric recorded)_ | OK |

### Metrics

All shadow write mismatches are recorded in:

```
shadow_write_mismatches_total{mismatch_type="status_mismatch"} 
shadow_write_mismatches_total{mismatch_type="data_mismatch"}
shadow_write_mismatches_total{mismatch_type="error_mismatch"}
```

Monitor these metrics in your Prometheus instance to detect issues early.

## Configuration

### Enable Shadow Write Mode

```bash
# .env or environment
NEW_PIPELINE=true
SHADOW_WRITE_MODE=true
```

### Disable (Production Default)

```bash
# .env or environment
SHADOW_WRITE_MODE=false
```

## Behavior in Different Scenarios

### Scenario 1: Both Pipelines Succeed Identically

```javascript
// Old: settlement.status = 'settled', isDuplicate = false
// New: settlement.status = 'settled', isDuplicate = false
// Result: Old result returned, no metrics recorded ✅
```

### Scenario 2: Results Differ

```javascript
// Old: settlement.status = 'settled'
// New: settlement.status = 'pending'
// Result: Old result returned, status_mismatch metric recorded ⚠️
```

Alert on these metrics in staging/production to catch bugs.

### Scenario 3: New Pipeline Fails, Old Succeeds

```javascript
// Old: settlement.status = 'settled'
// New: ERROR
// Result: Old result returned, error_mismatch metric recorded ⚠️
```

The call succeeds (returns old result), but the error is flagged for investigation.

### Scenario 4: Old Pipeline Fails

```javascript
// Old: ERROR
// New: settlement.status = 'settled'
// Result: Error thrown to caller ❌
```

The request fails, ensuring data integrity. The new pipeline's success doesn't mask a failure in the primary (old) pipeline.

## Monitoring & Alerting

### Prometheus Queries

Detect any shadow write mismatches:

```promql
rate(shadow_write_mismatches_total[5m]) > 0
```

Break down by mismatch type:

```promql
rate(shadow_write_mismatches_total{mismatch_type="error_mismatch"}[5m])
```

### Alert Example (Grafana)

```yaml
- alert: ShadowWriteMismatchDetected
  expr: rate(shadow_write_mismatches_total[5m]) > 0
  for: 1m
  annotations:
    summary: "Shadow write pipeline mismatch detected"
    description: "New pipeline produces different results than old."
    runbook: "docs/shadow-write-debug.md"
```

## Migration Workflow

### Phase 1: Validation (Staging)

1. Enable both `NEW_PIPELINE=true` and `SHADOW_WRITE_MODE=true` in **staging**
2. Run load tests / replay production traffic
3. Monitor `shadow_write_mismatches_total` metrics
4. Verify all mismatches are investigated and resolved
5. **Document any known issues**

### Phase 2: Production Canary

1. Enable `SHADOW_WRITE_MODE=true` for a small percentage of tenants
2. Run for 24–48 hours
3. Check for mismatches:
   ```promql
   rate(shadow_write_mismatches_total[1h]) > 0
   ```
4. If clean, continue to Phase 3

### Phase 3: Production Rollout

1. Gradually increase shadow write traffic
2. After 100% coverage with zero mismatches for 1+ week:
   - Set `SHADOW_WRITE_MODE=false` (disable shadow writes)
   - Keep `NEW_PIPELINE=true` (use new pipeline exclusively)
3. Monitor for issues in new pipeline
4. After 2 weeks with no problems, decommission old pipeline

### Phase 4: Cleanup (Optional)

Remove all old pipeline code and database tables.

## Troubleshooting

### Issue: Many `status_mismatch` Errors

**Cause**: The two pipelines handle settlement statuses differently.

**Resolution**:
1. Review settlement status logic in both implementations
2. Add unit tests to verify status transitions
3. Ensure both pipelines use the same status enum

### Issue: `error_mismatch` but New Pipeline is Faster

**Cause**: New pipeline completed, but old pipeline timed out or had a transient error.

**Resolution**:
1. Check database lock timeout settings (`DB_LOCK_TIMEOUT_*`)
2. Review old pipeline's error handling and retry logic
3. Increase timeout if old pipeline needs more time

### Issue: Data Differs (amount, bondId)

**Cause**: Input validation or transformation differs between pipelines.

**Resolution**:
1. Compare input normalization logic (trimming, type conversion)
2. Verify both use the same Zod schema
3. Add field-level logging to identify where data diverges

## API & Public References

The shadow write feature is **internal** to the settlement service and does not expose any new public API endpoints. The behavior is transparent to API consumers:

- Settlement writes continue to work as before
- Results are always consistent (old pipeline is primary)
- No changes to request/response schemas

### Backward Compatibility

✅ **Fully backward-compatible**. Enabling shadow write mode does not change:

- Request shapes (POST /api/payouts)
- Response shapes
- Error codes or messages
- Business logic or side effects

## Implementation Details

### Key Files

- [`src/config/featureFlags.ts`](src/config/featureFlags.ts) – Feature flag definitions
- [`src/services/shadowWrite.ts`](src/services/shadowWrite.ts) – Shadow write logic and comparison
- [`src/services/settlementService.ts`](src/services/settlementService.ts) – Integration point
- [`src/middleware/metrics.ts`](src/middleware/metrics.ts) – Prometheus metric definitions

### Function Signatures

```typescript
// Execute shadow write to both pipelines
export async function executeShadowWrite(
  oldRepository: SettlementsRepository,
  newRepository: SettlementsRepository,
  input: CreateSettlementInput
): Promise<{
  primaryResult: { settlement: Settlement; isDuplicate: boolean }
  hadMismatch: boolean
}>

// Compare results and record metrics
export function diffAndRecordShadowWrites(result: ShadowWriteResult): boolean
```

## Testing

Shadow write functionality is tested in:

- [`src/services/shadowWrite.test.ts`](src/services/shadowWrite.test.ts) – Unit tests for comparison logic
- [`src/services/settlementService.test.ts`](src/services/settlementService.test.ts) – Integration tests

Run tests locally:

```bash
npm test -- shadowWrite.test.ts
npm test -- settlementService.test.ts
```

## Environment Variables

| Variable | Type | Default | Required |
|----------|------|---------|----------|
| `NEW_PIPELINE` | boolean | `false` | No |
| `SHADOW_WRITE_MODE` | boolean | `false` | No |

Both must be `true` for shadow write to be active.

## Rollback

If mismatches are discovered in shadow write mode:

1. **Do not panic** – The old pipeline result is returned, so data integrity is preserved
2. Investigate the mismatch (check logs, compare logic)
3. Fix the new pipeline
4. Re-enable shadow write after fix is verified
5. If new pipeline is fundamentally broken, disable it:
   ```bash
   NEW_PIPELINE=false
   SHADOW_WRITE_MODE=false
   ```

## References

- **Issue**: [#677](https://github.com/example/repo/issues/677) – Add shadow write mode for new pipeline
- **Feature Flag Design**: [docs/feature-flags.md](feature-flags.md)
- **Settlement Service**: [docs/settlement-reconciliation.md](settlement-reconciliation.md)
- **Monitoring**: [docs/monitoring.md](monitoring.md)
