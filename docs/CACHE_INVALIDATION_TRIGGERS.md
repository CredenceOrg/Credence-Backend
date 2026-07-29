# Cache Invalidation Triggers

This guide maps cache writes to the operations that must clear them. Use it when reviewing a change that updates bonds, attestations, settlements, reports, replay jobs, tenant-scoped data, profile data, trust scores, or bulk-verification jobs.

For TTLs and cache ownership, read [CACHE_INVENTORY.md](CACHE_INVENTORY.md). For the invalidation API and bus behavior, read [CACHE_INVALIDATION.md](CACHE_INVALIDATION.md).

## Trigger Matrix

| Mutation trigger | Cache namespace and keys | Invalidation entrypoint | Source |
| --- | --- | --- | --- |
| Bond status update | `bond:id:{id}` and `bond:identity:{identityAddress}` | `invalidateCache()` for both keys after `BondsRepository.updateStatus()` returns the updated bond | `src/services/bondCacheService.ts` |
| Bond debit | `bond:id:{id}` and `bond:identity:{identityAddress}` | `invalidateCache()` for both keys after `BondsRepository.debit()` returns the updated bond | `src/services/bondCacheService.ts` |
| Attestation score update | `attestation:id:{id}`, `attestation:subject:{subjectAddress}`, and `attestation:bond:{bondId}` | `invalidateCache()` for all related lookup keys; the ID key uses stale-score verification | `src/services/attestationCacheService.ts` |
| Attestation creation | Subject and bond attestation lists, plus the broader `attestation` namespace | `invalidateForAttestation()` clears subject, bond, and namespace-level entries after create | `src/services/attestationCacheService.ts` |
| Settlement upsert | `settlement:{transactionHash}`, `settlement:id:{id}`, and `settlement:bondId:{bondId}` | `invalidateMultiple()` after the upsert result is known | `src/services/settlementService.ts` |
| Batch settlement upsert | `settlement:{transactionHash}` for each batch item | `invalidateCache()` with status verification per returned settlement | `src/services/settlementService.ts` |
| Report job status transition | `report:{jobId}` | `invalidateCache()` after the report repository status update and fresh job reload | `src/jobs/reportWorker.ts` |
| Failed-event replay | `failed_event:{id}` | `invalidateCache()` with status verification after replay status changes | `src/services/replayService.ts` |
| Tenant support purge | Every key in the tenant UUID namespace | `invalidateTenantCache()` after UUID validation and cache health check | `src/cli/invalidateTenantCache.ts`, `src/cache/invalidation.ts` |
| Profile or member mutation | `member:org:{orgId}:members` and `member:id:{memberId}` | `profileInvalidationHook.execute(orgId, memberId)` | `src/cache/invalidationHooks.ts` |
| Trust-score recalculation | `trust:{addressLowerCase}` | `trustScoreInvalidationHook.execute(...addresses)` | `src/cache/invalidationHooks.ts` |
| Bulk-verification completion | `bulk:job:{jobId}` and `bulk:org:{orgId}:results` | `bulkVerificationInvalidationHook.execute(jobId, orgId)` | `src/cache/invalidationHooks.ts` |

## Reviewer Checklist

- Identify every read-through cache key that could have been populated before the mutation.
- Invalidate all equivalent lookup shapes, not only the key used by the current request.
- Prefer `createCacheKey()` for structured keys so docs, services, and tests use the same shape.
- Use `verify: true` when a stale value can cause a user-visible status, score, or amount mismatch.
- Keep invalidation after the database mutation has succeeded. If the mutation is transactional, use the post-commit path already built into `invalidateCache()`.
- Publish through the shared invalidation utilities instead of deleting Redis keys directly, so other replicas receive the invalidation bus event.

## Safe Failure Modes

Invalidation should not leak cached values into logs. If a cache backend is unavailable, surface the operation-specific error and log key counts or namespaces only. The tenant purge CLI follows this rule by validating UUID input, checking cache health, and returning only `{ tenantId, keysCleared }`.

## Adding A New Trigger

When a new mutation writes data that has a cached read path:

1. Add or update the cached read key in `docs/CACHE_INVENTORY.md`.
2. Add the mutation-to-key mapping in this file.
3. Invalidate every affected key through `invalidateCache()`, `invalidateMultiple()`, `invalidatePattern()`, or a named hook from `src/cache/invalidationHooks.ts`.
4. Add a unit or static test that proves the mutation path references the expected invalidation entrypoint.
5. Include the local command in the PR description, for example `npm test -- src/cache/invalidation.test.ts` or the narrower test file that covers the new trigger.
