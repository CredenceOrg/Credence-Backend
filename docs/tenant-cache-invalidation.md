# Tenant Cache Invalidation (Support CLI)

A support-focused CLI command for clearing a single tenant's cached data —
Redis and the per-process L1 cache — without restarting the service.

## When to use this

Use this command when a support ticket reports stale data for one tenant
(e.g. a setting or record they just changed still shows the old value) and
you need it resolved immediately, rather than waiting out the cache TTL.

This is a support/operations tool, not part of the HTTP API — it's meant to
be run from a shell with access to the backend's runtime environment
(`REDIS_URL`, etc.), the same way `scripts/rotate-kms-key.ts` or
`scripts/restore-verify.ts` are run.

## Usage

```bash
npx tsx src/cli/invalidateTenantCache.ts --tenant <uuid>

# or via the npm script
npm run cache:invalidate-tenant -- --tenant <uuid>

# help
npm run cache:invalidate-tenant -- --help
```

### Example

```bash
$ npm run cache:invalidate-tenant -- --tenant 3fa85f64-5717-4562-b3fc-2c963f66afa6
Invalidated cache for tenant 3fa85f64-5717-4562-b3fc-2c963f66afa6: 12 key(s) cleared.
```

If the tenant has nothing cached, the command still exits successfully:

```bash
$ npm run cache:invalidate-tenant -- --tenant 3fa85f64-5717-4562-b3fc-2c963f66afa6
No cached entries found for tenant 3fa85f64-5717-4562-b3fc-2c963f66afa6. Nothing to do.
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Ran successfully (including "nothing to clear") |
| `1`  | Missing/invalid `--tenant`, or the cache backend was unreachable |

## Tenant identifier

`--tenant` must be a valid UUID, matching the `tenant_id` column used
throughout the schema (see [`multi-tenancy.md`](./multi-tenancy.md)).
Anything else — an empty value, a slug, or a value containing wildcard
characters like `*` — is rejected before any cache call is made.

This is deliberate: cache invalidation is namespace-based (`clearNamespace`
runs a `KEYS <namespace>:*` scan under the hood), so a malformed or
attacker-supplied identifier containing glob characters could otherwise
match and delete far more than the intended tenant's keys. Requiring a
well-formed UUID closes that off.

## What gets cleared

Tenant-scoped cache entries are stored under a namespace equal to the
tenant's ID (e.g. `cache.set(tenantId, key, value)`, see
[`caching.md`](./caching.md) for the general cache API). Running this
command clears that tenant's entire namespace — both the shared Redis layer
and the calling process's local L1 cache — via the existing
`CacheService.clearNamespace()` primitive in `src/cache/redis.ts`.

It does **not** touch any other tenant's cache entries, and it does not
touch the database — only cached copies are cleared, so the next read simply
repopulates the cache from the source of truth.

## Safety notes

- **Non-destructive to source data.** This only clears cached copies. Worst
  case is a temporary cache-miss for that tenant until entries repopulate.
- **Stampede protection already exists.** Reads that repopulate the cache
  via `CacheService.getOrFetch()` are deduplicated with SingleFlight (see
  [`caching.md`](./caching.md#cache-stampede-protection-singleflight)), so
  clearing a busy tenant's cache does not cause a thundering herd of
  duplicate origin calls.
- **Bounded cross-instance staleness.** This command clears Redis (the
  shared L2 cache) and the local process's L1 cache immediately. Other
  running instances' L1 caches are not explicitly notified, but L1 entries
  expire after at most 60 seconds (`CacheService`'s default L1 TTL), so
  staleness on other instances is bounded to that window.
- **No tenant data is ever logged.** Only the tenant ID and the number of
  keys cleared are logged or printed — never cached values or Redis key
  contents.
- **Run during low-traffic windows when possible**, since clearing a large,
  frequently-read tenant's cache does briefly shift load back to the
  database/origin for that tenant until the cache warms back up.

## Testing

```bash
npm test -- src/cache/__tests__/invalidateTenantCache.test.ts
npm test -- src/cli/invalidateTenantCache.test.ts
```

Covered scenarios: successful invalidation, invalid/malformed tenant input,
a tenant with no cache entries, and cache-backend failure handling.
