# Cache Invalidation Strategy

## Overview

This document describes the cache invalidation strategy implemented to ensure read-after-write consistency across the Credence backend. The implementation closes invalidation gaps that could lead to stale reads in concurrent environments, and supports distributed deployments with multiple API replicas.

## Problem Statement

Without proper cache invalidation, the following race conditions can occur:

1. Process A updates a database record (e.g., settlement status: `pending` → `completed`)
2. Process B reads from cache before invalidation completes
3. Process B receives stale data (status: `pending`)
4. Users see inconsistent state

In distributed deployments, even if invalidation is done in-process on the updating replica, other replicas may still serve stale data from their local caches or even Redis (if sharded).

## Solution Architecture

### Core Components

#### 1. Cache Layers (`src/cache/redis.ts`)
- **L1 Cache**: In-memory LRU cache for hot data (default: 1000 items, 1 min TTL)
- **L2 Cache**: Redis for shared, persistent caching across replicas

All cache operations first check L1, then fall back to L2. Updates are written to both caches.

#### 2. Invalidation Bus (`src/cache/invalidationBus.ts`)
- Uses Postgres LISTEN/NOTIFY to broadcast invalidation events across replicas
- Channel name is environment-scoped to prevent cross-env leakage
- Auto-reconnects to Postgres if the listen client disconnects
- Each replica automatically invalidates its L1/L2 caches when receiving invalidation events

#### 3. Cache Invalidation Utilities (`src/cache/invalidation.ts`)

Provides reusable patterns for cache invalidation:

- `invalidateCache()` - Invalidate a single cache key with optional verification and broadcast
- `invalidateMultiple()` - Invalidate multiple keys atomically and broadcast
- `invalidatePattern()` - Invalidate keys matching a pattern and broadcast
- `createCacheKey()` - Helper to create consistent cache keys

#### 4. Cache-Aware Services

Services that wrap repositories and handle cache invalidation:

- `BondCacheService` - Caching for bond operations
- `AttestationCacheService` - Caching for attestation operations
- `SettlementService` - Enhanced with proper invalidation
- `ReportService` - Enhanced with proper invalidation
- `ReplayService` - Enhanced with proper invalidation

### Invalidation Patterns

#### Pattern 1: Post-Commit Invalidation

Invalidate cache immediately after database update:

```typescript
async updateStatus(id: number, status: BondStatus): Promise<Bond | null> {
  // 1. Update database
  const bond = await this.repository.updateStatus(id, status)
  
  if (bond) {
    // 2. Invalidate cache post-commit
    await invalidateCache('bond', createCacheKey('id', id), bond, { verify: true })
  }
  
  return bond
}
```

#### Pattern 2: Multi-Key Invalidation

Invalidate multiple related caches:

```typescript
async updateScore(id: number, score: number): Promise<Attestation | null> {
  const attestation = await this.repository.updateScore(id, score)
  
  if (attestation) {
    // Invalidate ID, subject, and bond-based caches
    await Promise.all([
      invalidateCache('attestation', createCacheKey('id', id), attestation),
      invalidateCache('attestation', createCacheKey('subject', attestation.subjectAddress)),
      invalidateCache('attestation', createCacheKey('bond', attestation.bondId))
    ])
  }
  
  return attestation
}
```

#### Pattern 3: Verified Invalidation

Verify cache was actually cleared (stale-read detection):

```typescript
await invalidateCache(
  'settlement',
  transactionHash,
  settlement,
  {
    verify: true,
    verifyFn: (cached, fresh) => cached.status !== fresh.status
  }
)
```

If stale data is detected after invalidation, a metric is recorded for monitoring.

## Implementation Details

### Services with Cache Invalidation

| Service | Operations | Cache Keys | Verification |
|---------|-----------|------------|--------------|
| `SettlementService` | `upsertSettlementStatus` | `settlement:{hash}` | ✅ Status check |
| `BondCacheService` | `updateStatus`, `debit` | `bond:id:{id}`, `bond:identity:{addr}` | ✅ Enabled |
| `AttestationCacheService` | `updateScore`, `create` | `attestation:id:{id}`, `attestation:subject:{addr}`, `attestation:bond:{id}` | ✅ Score check |
| `ReportService` | `updateStatus` | `report:{id}` | ✅ Status check |
| `ReplayService` | `replayEvent` | `failed_event:{id}` | ✅ Status check |

### Cache TTL Strategy

Different TTL values based on data volatility:

- **Settlements**: 300s (5 minutes) - Relatively stable after creation
- **Bonds**: 300s (5 minutes) - Changes infrequent
- **Attestations**: 300s (5 minutes) - Changes infrequent
- **Reports**: 60s (1 minute) for active jobs, 300s for terminal states
- **Failed Events**: 300s (5 minutes)

### Concurrency Safety

The implementation is concurrency-safe through:

1. **Atomic Operations**: Cache invalidation happens immediately after DB commit
2. **Verification**: Optional stale-read detection catches race conditions
3. **Metrics**: `stale_cache_reads_total` counter tracks invalidation failures
4. **Multi-Key Invalidation**: Related caches invalidated atomically via `Promise.all()`

## Monitoring

### Metrics

Track cache invalidation effectiveness:

```typescript
// Stale cache reads detected
stale_cache_reads_total{namespace="settlement"} 0
stale_cache_reads_total{namespace="bond"} 0
stale_cache_reads_total{namespace="attestation"} 0
```

### Alerts

Set up alerts for stale cache reads:

```yaml
- alert: StaleCacheReadsDetected
  expr: rate(stale_cache_reads_total[5m]) > 0
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Stale cache reads detected in {{ $labels.namespace }}"
    description: "Cache invalidation may not be working correctly"
```

## Testing

### Unit Tests

Each cache service has comprehensive tests:

- `src/cache/__tests__/invalidation.test.ts` - Core invalidation utilities
- `src/services/__tests__/bondCacheService.test.ts` - Bond caching
- `src/services/__tests__/attestationCacheService.test.ts` - Attestation caching
- `src/services/settlementService.test.ts` - Settlement caching (existing)
- `src/services/reportService.test.ts` - Report caching (existing)

### Integration Tests

Test cache invalidation in realistic scenarios:

```typescript
it('should not return stale data after status update', async () => {
  // Create bond
  const bond = await bondService.createBond(input)
  
  // Cache the bond
  await bondService.getBondById(bond.id)
  
  // Update status
  await bondService.updateStatus(bond.id, 'released')
  
  // Read should return fresh data
  const updated = await bondService.getBondById(bond.id)
  expect(updated.status).toBe('released')
})
```

## Migration Guide

### For Existing Services

To add cache invalidation to an existing service:

1. **Import utilities**:
   ```typescript
   import { cache } from '../cache/redis.js'
   import { invalidateCache, createCacheKey } from '../cache/invalidation.js'
   ```

2. **Add caching to read operations**:
   ```typescript
   async getById(id: string): Promise<Entity | null> {
     const cached = await cache.get<Entity>('entity', id)
     if (cached) return cached
     
     const entity = await this.repository.findById(id)
     if (entity) {
       await cache.set('entity', id, entity, 300)
     }
     return entity
   }
   ```

3. **Add invalidation to write operations**:
   ```typescript
   async update(id: string, data: UpdateInput): Promise<Entity> {
     const entity = await this.repository.update(id, data)
     await invalidateCache('entity', id, entity, { verify: true })
     return entity
   }
   ```

### For New Services

Use cache-aware service pattern from the start:

1. Create service class that wraps repository
2. Implement caching in read methods
3. Implement invalidation in write methods
4. Add comprehensive tests

## Best Practices

1. **Always invalidate after writes**: Never update database without invalidating cache
2. **Use verification for critical paths**: Enable `verify: true` for status/amount changes
3. **Invalidate related caches**: Consider all cache keys that might be affected
4. **Use consistent cache keys**: Use `createCacheKey()` helper for consistency
5. **Monitor stale reads**: Set up alerts on `stale_cache_reads_total` metric
6. **Test invalidation**: Include cache invalidation in integration tests
7. **Document cache keys**: Maintain table of cache keys per service

## Performance Considerations

### Cache Invalidation Overhead

- Single key invalidation: ~1-2ms (Redis DELETE)
- Multi-key invalidation: ~2-5ms (parallel DELETE operations)
- Verification: +1-2ms (additional GET operation)

### Trade-offs

- **With verification**: Higher latency (~3-4ms) but catches race conditions
- **Without verification**: Lower latency (~1-2ms) but may miss stale reads
- **Recommendation**: Use verification for critical status/amount updates

## Future Enhancements

1. **Cache warming**: Pre-populate cache after updates
2. **Batch invalidation**: Optimize multi-key invalidation
3. **TTL optimization**: Dynamic TTL based on access patterns
4. **Cache versioning**: Version-based invalidation for complex scenarios
5. **Distributed invalidation**: Pub/sub for multi-instance deployments

## References

- [Caching Documentation](./caching.md)
- [Monitoring Documentation](./monitoring.md)
- [Redis Cache Implementation](../src/cache/redis.ts)
- [Cache Invalidation Utilities](../src/cache/invalidation.ts)
