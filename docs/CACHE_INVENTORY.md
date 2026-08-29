# Cache Inventory

A single reference table of **every cache namespace in the codebase and its TTL** —
what's cached, how long it lives, where the TTL is defined, and how to change it.

This is a reference for contributors adding or reviewing caching code and for
anyone answering "how long until X shows up / expires?" without reading source.
For *how the cache client works* (API, stampede protection, headers), see
[caching.md](caching.md). For *invalidation patterns* (post-commit invalidation,
verification, the cross-replica bus), see [CACHE_INVALIDATION.md](CACHE_INVALIDATION.md).

There are four distinct caching mechanisms in this codebase. They are **not
interchangeable** and don't share invalidation or observability — treat each
namespace below as belonging to exactly one of these:

1. **`CacheService`** (`src/cache/redis.ts`) — L1 in-memory LRU (max 1000 entries,
   fixed 60s TTL) + L2 Redis (per-call TTL). Keys are auto-namespaced as
   `{namespace}:{key}`. Deletes broadcast to every replica via the Postgres
   LISTEN/NOTIFY invalidation bus (`src/cache/invalidationBus.ts`).
2. **Rate-limit counters** — Redis fixed-window counters, written directly via
   the raw Redis client, not through `CacheService`. No L1, no invalidation bus.
3. **In-process caches** — plain `Map`/LRU instances local to one Node process.
   Never synced across replicas; each replica ages entries out on its own clock.
4. **Raw `ioredis` usage** — one service (governance proposals) talks to Redis
   directly and does not use `CacheService` at all.

## 1. `CacheService` namespaces (Redis, L1 + L2)

| Namespace | Key pattern | Default TTL | Override | Source |
|---|---|---|---|---|
| `trust` | `{address.toLowerCase()}` | **600s** (10 min) | env `TRUST_SCORE_CACHE_TTL` (60–86400s) | [`src/config/index.ts:20-24`](../src/config/index.ts), used in [`src/services/reputationService.ts:175-176`](../src/services/reputationService.ts) |
| `bond` | `id:{id}`, `identity:{address}` | **300s** (5 min) | env `BOND_CACHE_TTL_SECONDS` (1–86400s) | [`src/config/index.ts:26-30`](../src/config/index.ts), [`src/services/bondCacheService.ts`](../src/services/bondCacheService.ts) |
| `bond` ⚠️ | `{address.toLowerCase()}` (no key prefix) | **300s**, hard-coded | none — separate constant from the row above | [`src/routes/bond.ts:9,78`](../src/routes/bond.ts) |
| `attestation` | `id:{id}`, `subject:{address}`, `bond:{bondId}`, `subject:{address}:page:{offset}:{limit}` | **300s** (5 min) | env `ATTESTATION_CACHE_TTL_SECONDS` (1–86400s) | [`src/config/index.ts:32-36`](../src/config/index.ts), [`src/services/attestationCacheService.ts`](../src/services/attestationCacheService.ts) |
| `settlement` | `{transactionHash}` | **300s**, hard-coded | none | [`src/services/settlementService.ts:38`](../src/services/settlementService.ts) |
| `report` | `{jobId}` | **60s** while job is active, **300s** once `COMPLETED`/`FAILED` | none | [`src/services/reportService.ts:9,97-114`](../src/services/reportService.ts) |
| `report` | `report-dedup:{tenantId}:{requestHash}` | **300s**, hard-coded | none | [`src/services/reportService.ts:70`](../src/services/reportService.ts) — dedups identical in-flight report requests |
| `report` | `report-count:{tenantId}` | **300s**, hard-coded | none | [`src/services/reportService.ts:76`](../src/services/reportService.ts) — active-job counter for the per-org concurrency cap |
| `failed_event` | `{id}` | **300s**, hard-coded | none | [`src/services/replayService.ts:7,59`](../src/services/replayService.ts) |
| `analytics` | `{tenantId}:gen{N}[:queryString]` | **300s**, hard-coded | none | [`src/routes/analytics.ts:9-10,90`](../src/routes/analytics.ts) — see generation caveat below |
| `soroban_state` | `{network}:{contractId}:{address.toLowerCase()}` | **5000ms** (5s) | env `SOROBAN_STATE_CACHE_TTL_MS`; `0` disables caching entirely | [`src/config/index.ts:507-516`](../src/config/index.ts), [`src/clients/sorobanStateCache.ts`](../src/clients/sorobanStateCache.ts) |
| `idempotency` | `{handlerType}:{messageId}` | **86400s** (24h) | constructor option `ttlSeconds` on `IdempotencyGuard` (no call site currently overrides it) | [`src/lib/idempotencyGuard.ts:87`](../src/lib/idempotencyGuard.ts) — for at-least-once message consumers; unrelated to the HTTP idempotency middleware below |

⚠️ **`bond` is used by two independent producers with different key shapes.**
`BondCacheService` (`id:N` / `identity:addr`) and the `GET /api/bond/:address`
route (a bare lowercased address, no prefix) both write into the `bond`
namespace but never collide today because their key shapes don't overlap.
They also don't share a TTL source — changing `BOND_CACHE_TTL_SECONDS` only
affects `BondCacheService`; the route's cache stays at its own hard-coded
300s. If you add a third `bond`-namespace producer, pick a key shape that
can't collide with either of the above.

**`analytics` generation caveat**: the `gen{N}` token is a process-local
counter (`src/services/analytics/cacheGeneration.ts`), not a Redis counter.
Bumping it invalidates every previously-cached key *on that replica only* —
other replicas keep serving their own generation's cached entries until the
300s TTL expires them naturally. This is a deliberate O(1)-invalidation
trade-off, not a bug; see the file's header comment if you need cross-replica
invalidation for this namespace.

**`governance:proposal:{id}`** is a fifth Redis key worth knowing about even
though it bypasses `CacheService` entirely — see [§4](#4-not-cacheservice-raw-ioredis-usage).

## 2. Rate-limit counters (Redis, not `CacheService`)

These are fixed-window request counters, not data caches — listed here because
they're TTL-bearing Redis keys people go looking for under "cache." Full design
in [rate-limiting.md](rate-limiting.md).

| Key pattern | Window (TTL) | Ceiling | Source |
|---|---|---|---|
| `ratelimit:api:tenant:{tenantId}:{windowStart}` or `ratelimit:api:ip:{ip}:{windowStart}` | env `RATE_LIMIT_WINDOW_SEC`, default **60s** | per tier: `RATE_LIMIT_MAX_FREE`/`_PRO`/`_ENTERPRISE` = 100 / 1000 / 10000 | [`src/middleware/rateLimit.ts:174-215`](../src/middleware/rateLimit.ts), config [`src/config/index.ts:367-390`](../src/config/index.ts) |
| `ratelimit:api:key:{apiKeyId}:{windowStart}` | same window | same tier ceiling, tracked independently per key | [`src/middleware/rateLimit.ts:215`](../src/middleware/rateLimit.ts) |
| `ratelimit:auth:tenant:{tenantId}:{windowStart}` (IP fallback if no tenant) | env `AUTH_RATE_LIMIT_WINDOW_SEC`, default **60s** | env `AUTH_RATE_LIMIT_MAX_PER_TENANT`, default **20** | [`src/middleware/authRateLimit.ts`](../src/middleware/authRateLimit.ts), config [`src/config/index.ts:405-414`](../src/config/index.ts) |

Per-tenant window/ceiling overrides live in the Postgres `tenant_rate_limit_overrides`
table, not Redis — they're read on each request and substituted into the
Redis key/ceiling above (`src/middleware/rateLimit.ts:190-200`).

## 3. In-process caches (no Redis, not shared across replicas)

| Cache | TTL | Key prefix(es) | Source |
|---|---|---|---|
| Feature flags | **30000ms** (30s); swept every 60000ms | `feature_flag:`, `feature_flags:all`, `feature_flag_override:`, `feature_flag_tenant_rollout:` | [`src/services/featureFlags/consts.ts:10-25`](../src/services/featureFlags/consts.ts), env `FLAG_CACHE_TTL_MS` |
| Authorization policy rules | **30000ms** (30s) | keyed by `orgId` (or `'*'`) | [`src/services/policy/store.ts:12`](../src/services/policy/store.ts) — invalidated on every write, not just on TTL expiry |
| JWKS export | **600000ms** (10 min) | single cached `JwksResponse` | [`src/services/keyManager/index.ts:16`](../src/services/keyManager/index.ts) — invalidated immediately on key rotation/pruning |
| JWKS HTTP `Cache-Control` | **300s** (5 min) — a *different* layer from the row above, facing CDNs/clients | n/a (`GET /.well-known/jwks.json` response header, with ETag `304` support) | [`src/routes/jwks.ts:9-13`](../src/routes/jwks.ts), env `JWKS_CACHE_MAX_AGE_SECONDS` |
| Health-probe results (`withProbeCache`) | caller-supplied `ttlMs`; stale-while-revalidate | n/a (wraps any `HealthProbe`) | [`src/clients/healthProbeCache.ts`](../src/clients/healthProbeCache.ts) |
| DB prepared-statement names | **no TTL** — capacity-bounded, not time-bounded | n/a (keyed by query text) | [`src/db/pool.ts:236-268`](../src/db/pool.ts), env `DB_PREPARED_STATEMENT_CACHE_MAX` (default 200 entries) — a query-plan cache, not a data cache |

## 4. Not `CacheService`: raw `ioredis` usage

| Key pattern | TTL | Source |
|---|---|---|
| `governance:proposal:{id}` | `(proposal.expiresAt − now) + 86400s` grace buffer; flat **3600s** if the proposal already expired | [`src/services/governance/redisStorage.ts`](../src/services/governance/redisStorage.ts) |

`RedisProposalStorage` writes via `ioredis` (`redis.set(key, val, 'EX', ttl)`)
directly, not through `cache`/`CacheService`. It gets no L1 layer, no
cross-replica invalidation broadcast, and its key already contains the literal
`governance:proposal:` prefix rather than relying on `CacheService`'s automatic
`namespace:key` prefixing — don't assume the admin purge-cache endpoint
(`namespace: "governance"`) will reach it; it won't, because it never goes
through `CacheService` in the first place.

## Adjacent, but not a cache

These are Postgres-backed rows with a TTL/expiry concept, easy to confuse with
the Redis caches above because "TTL" shows up in each one's code too. None of
them are invalidated by `invalidateCache()`, none show up under
`GET /api/admin/purge-cache`, and none share a namespace with anything above.

| What | Default TTL | Source |
|---|---|---|
| HTTP idempotency keys (`Idempotency-Key` header, global `/api` mount) | **86400s**, from `config.idempotency.ttlSeconds` (env `IDEMPOTENCY_TTL_SECONDS`) | [`src/app.ts:187-195`](../src/app.ts), [`src/middleware/idempotency.ts`](../src/middleware/idempotency.ts) |
| HTTP idempotency keys (`POST /api/payouts`) ⚠️ | **86400s**, hard-coded default — **does not read `IDEMPOTENCY_TTL_SECONDS`** | [`src/routes/payouts.ts:38`](../src/routes/payouts.ts) calls `idempotencyMiddleware(idempotencyRepo)` with no `expiresInSeconds`, so it always falls back to the middleware's own default regardless of the env var |
| "Session" rows (table is actually `idempotent_job_attempts`) | **86400s**, env `SESSION_TTL_SECONDS` | [`src/config/constants.ts:30-31`](../src/config/constants.ts), swept by `src/jobs/expiredSessionsSweeper.ts` |
| Impersonation tokens | default **900s** (15 min), capped at **3600s** (1h) | [`src/services/impersonation/index.ts:14-16`](../src/services/impersonation/index.ts) |
| Webhook secret rotation grace window | **86400000ms** (24h) | [`src/services/webhooks/rotationService.ts:7`](../src/services/webhooks/rotationService.ts) |
| Request snapshots | **14 days** | [`src/db/repositories/requestSnapshotsRepository.ts:37`](../src/db/repositories/requestSnapshotsRepository.ts) |
| Notification idempotency markers | **86400s** | [`src/jobs/notificationIdempotency.ts:27`](../src/jobs/notificationIdempotency.ts) |

Also adjacent: Redis-backed **distributed locks** (`cron:score-snapshot`,
plus per-worker locks for invoice due-dates, exports, and analytics refresh —
`src/jobs/lockedWorkers.ts`, TTLs 15–60 min) coordinate exclusive job execution
across replicas. They use the same Redis instance and `SET ... PX` semantics
as the caches above, but they're mutexes, not data caches — see
`src/jobs/distributedLock.ts`.

## Checking or changing a TTL

**Read the current remaining TTL for a live key** (matches `CacheService.ttl()`,
[`src/cache/redis.ts:140-147`](../src/cache/redis.ts)):

```ts
import { cache } from '../cache/redis.js'

const remaining = await cache.ttl('bond', 'id:42')
// > 0  → seconds remaining
// -1   → key exists, no expiry
// -2   → key doesn't exist
```

**Change a TTL that's env-driven** (`trust`, `bond` (via `BondCacheService`),
`attestation`, `soroban_state`, rate limits, JWKS `Cache-Control`, feature
flags): set the corresponding env var — see the "Override" column above and
`.env.example`.

**Change a TTL that's hard-coded** (`settlement`, `report`, `failed_event`,
`analytics`, the `bond.ts` route cache, `idempotency`): edit the constant at
the cited source location directly. There's no env var for these today — if
you're adding one, follow the pattern in `src/config/index.ts` (Zod schema
with a `.default()` and a `.pipe()` bound) and add the new var to
`.env.example`.

**Purge a namespace or key manually** (operator action, audit-logged):

```bash
curl -X POST https://<host>/api/admin/purge-cache \
  -H "Authorization: Bearer <ADMIN_API_KEY_RAW>" \
  -H "Content-Type: application/json" \
  -d '{"namespace": "attestation", "key": "id:123"}'
```

This only reaches namespaces that go through `CacheService` — it will not
purge the `governance:proposal:` keys in [§4](#4-not-cacheservice-raw-ioredis-usage),
which never used `CacheService` to begin with. See
[admin-api.md](admin-api.md#purge-cache) for the full request/response shape.
