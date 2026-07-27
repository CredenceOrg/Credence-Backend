# Caching Layer

This document describes the Redis caching layer implementation for the Credence Backend.

## Overview

The caching layer provides a generic Redis-based caching service with:

- **Connection management** - Singleton Redis client with health monitoring
- **Namespacing** - Automatic key namespacing (e.g., `trust:score:0x123`)
- **TTL support** - Set expiration times on cached values
- **Type safety** - Full TypeScript support with JSDoc documentation
- **Error handling** - Graceful fallback when Redis is unavailable
- **Health checks** - Built-in Redis health monitoring

## Architecture

### RedisConnection

Singleton Redis client that manages the connection lifecycle:

```ts
import { redisConnection } from '../cache/redis.js'

// Auto-connects on first use
await redisConnection.connect()

// Health check
const healthy = await redisConnection.isHealthy()

// Graceful shutdown
await redisConnection.disconnect()
```

### CacheService

High-level caching interface with namespacing and TTL:

```ts
import { cache } from '../cache/redis.js'

// Store data with TTL
await cache.set('trust', 'score:0x123', { score: 85 }, 300)

// Retrieve data (auto-parses JSON)
const score = await cache.get('trust', 'score:0x123')

// Delete data
await cache.delete('trust', 'score:0x123')

// Health check
const { healthy, error } = await cache.healthCheck()
```

## API Reference

### CacheService Methods

#### `get<T>(namespace: string, key: string): Promise<T | null>`

Retrieve a cached value. Automatically parses JSON strings.

**Parameters:**
- `namespace` - Cache namespace (e.g., 'trust', 'bond')
- `key` - Key within namespace

**Returns:** Parsed value or `null` if not found

#### `getOrFetch<T>(namespace: string, key: string, fetchFn: () => Promise<T>, ttl: number): Promise<T>`

Read-through cache with **cache-stampede protection** via SingleFlight
coalescing.  When multiple concurrent callers miss the cache for the same
(namespace, key), only **one** origin call is made; all others transparently
wait for the same result.

**Parameters:**
- `namespace` - Cache namespace
- `key` - Key within namespace
- `fetchFn` - Origin fetch function called on cache miss
- `ttl` - Time-to-live in seconds for the cached value

**Stampede-protection details:**
1. Fast path: checks the cache — if hit, returns immediately.
2. Acquires a SingleFlight slot keyed to `(namespace, key)`.
3. Double-checks the cache after acquiring the slot (another caller may have
   populated it while we waited).
4. Calls `fetchFn` only if still a miss; stores the result in cache.
5. All waiters share the same resolved value (or error).

**Returns:** The cached or freshly-fetched value.

**Example:**
```ts
import { cache } from '../cache/redis.js'

const bond = await cache.getOrFetch(
  'bond',
  'id:42',
  () => repository.findById(42),
  300,
)
```

#### `set<T>(namespace: string, key: string, value: T, ttl?: number): Promise<boolean>`

Store a value in cache. Automatically JSON-serializes objects.

**Parameters:**
- `namespace` - Cache namespace
- `key` - Key within namespace  
- `value` - Value to cache (string or object)
- `ttl` - Optional time-to-live in seconds

**Returns:** `true` if successful, `false` on error

#### `delete(namespace: string, key: string): Promise<boolean>`

Delete a cached value.

**Returns:** `true` if key existed and was deleted

#### `clearNamespace(namespace: string): Promise<number>`

Delete all keys in a namespace.

**Returns:** Number of keys deleted

#### `exists(namespace: string, key: string): Promise<boolean>`

Check if a key exists.

**Returns:** `true` if key exists

#### `expire(namespace: string, key: string, ttl: number): Promise<boolean>`

Set TTL for an existing key.

**Returns:** `true` if TTL was set

#### `ttl(namespace: string, key: string): Promise<number>`

Get remaining TTL for a key.

**Returns:** 
- `> 0` - Remaining seconds
- `-1` - Key exists but has no expiry
- `-2` - Key doesn't exist

#### `healthCheck(): Promise<{ healthy: boolean; error?: string }>`

Check Redis connection health.

**Returns:** Health status with optional error message

## Namespaces

The cache automatically namespaces keys to prevent collisions:

```
trust:score:0x123     -> Trust score for address
bond:status:0x123     -> Bond status for address  
api:response:users    -> API response cache
```

Recommended namespaces:

- `trust` - Trust scores and reputation data
- `bond` - Bond status and amounts
- `api` - API response caching
- `session` - User session data
- `rate-limit` - Rate limiting data

## TTL Strategies

Recommended TTL values by data type:

| Data Type | TTL | Reason |
|-----------|-----|--------|
| Trust scores | 5-15 minutes | Balance freshness with performance |
| Bond status | 1-5 minutes | Critical data, shorter cache |
| API responses | 1-60 minutes | Varies by endpoint |
| Rate limits | 1 hour | Fixed window |
| Sessions | 24 hours | User session duration |

## Error Handling

The cache service is designed to be resilient:

- **Connection failures** - Methods return `null`/`false` instead of throwing
- **Redis errors** - Logged and gracefully handled
- **JSON parsing** - Falls back to string values if parsing fails
- **Health checks** - Use `healthCheck()` to verify Redis status

```ts
// Example: Fallback pattern
const cached = await cache.get('trust', 'score:0x123')
if (cached === null) {
  // Cache miss or Redis unavailable
  const fresh = await computeTrustScore('0x123')
  await cache.set('trust', 'score:0x123', fresh, 300)
  return fresh
}
return cached
```

## Environment Variables

Required Redis configuration:

```bash
# Redis connection URL
REDIS_URL=redis://localhost:6379

# Optional: Custom Redis settings
REDIS_CONNECT_TIMEOUT=5000
```

## Testing

The cache layer includes comprehensive tests:

```bash
# Run all cache tests
npm test src/cache/__tests__

# Run with coverage
npm run test:coverage
```

Tests cover:
- Connection management
- Cache operations (get/set/delete)
- TTL handling
- Namespacing
- Error scenarios
- Health checks

## Performance Considerations

- **Connection pooling** - Singleton client manages connection efficiently
- **Batch operations** - Use `clearNamespace()` for bulk deletions
- **Memory usage** - Set appropriate TTLs to prevent memory bloat
- **Network latency** - Cache frequently accessed data
- **JSON serialization** - Avoid caching very large objects

## Monitoring

Monitor Redis health and performance:

```ts
// Health check endpoint
app.get('/api/health/cache', async (req, res) => {
  const { healthy, error } = await cache.healthCheck()
  res.json({ 
    cache: { 
      healthy, 
      error: error || undefined 
    } 
  })
})
```

Key metrics to monitor:
- Connection success rate
- Cache hit/miss ratios
- Memory usage
- Response times
- Error rates

## Security

- **Network isolation** - Keep Redis in private networks
- **Authentication** - Use Redis AUTH in production
- **TLS encryption** - Enable Redis TLS for sensitive data
- **Key naming** - Avoid sensitive data in cache keys
- **Data sanitization** - Validate data before caching

## Cache Stampede Protection (SingleFlight)

A **cache stampede** (thundering herd) occurs when many concurrent requests
miss the cache for the same key simultaneously, each triggering an expensive
origin call. The `getOrFetch` method uses the `SingleFlight` pattern to
prevent this.

### How it Works

The `SingleFlight` class (`src/lib/singleflight.ts`) guarantees that for a
given deduplication key, only **one** async function executes at a time.
If a second caller arrives while the first is still in-flight, it
piggybacks on the same promise instead of starting a duplicate call.

```
Request A ──→ cache miss ──→ acquires slot ──→ fetchFn() ──→ all get result
Request B ──→ cache miss ──→ waits on A  ──────────────────→ all get result
Request C ──→ cache miss ──→ waits on A  ──────────────────→ all get result
                                                          (only 1 origin call)
```

### Double-Check Pattern

Inside the SingleFlight slot, `getOrFetch` re-checks the cache before
calling the origin (`fetchFn`). This handles the edge case where two
concurrent callers both miss the cache, but a previous SingleFlight
call already populated it by the time the waiter acquires the slot.

### When to Use

- Expensive or slow origin calls (DB queries, external API calls, complex
  computations)
- High-read, low-write data accessed by multiple concurrent handlers
- Any cache hot path where a miss triggers a noticeable load spike

The `SingleFlight` primitive can also be used standalone for any
problem that needs request coalescing:

```ts
import { singleflight } from '../lib/singleflight.js'

const result = await singleflight.do('my-operation-key', async () => {
  return await expensiveWork()
})
```

## Response Cache Headers (X-Cache)

To aid debugging and provide client-side reasoning about cache performance, responses from cached endpoints will contain an `x-cache` header indicating the cache status:
- `HIT` — The data was served entirely from the cache.
- `MISS` — The data was not in the cache and had to be computed or fetched from the database.
- `STALE` — The data was retrieved from the cache but was determined to be stale based on its age or timestamp indicators.

This tracking is automatically managed by `cacheHeaderMiddleware` using asynchronous local storage context during request processing.

## Best Practices

1. **Always set TTL** - Prevent memory leaks
2. **Use namespaces** - Avoid key collisions
3. **Handle failures** - Always check return values
4. **Monitor health** - Use health checks in production
5. **Test failures** - Verify graceful degradation
6. **Document TTLs** - Clear cache invalidation strategy
7. **Size limits** - Avoid caching very large objects
8. **Consistent patterns** - Standardize key naming

## Admin Cache Purging Endpoint

Operators can manually purge cache keys, patterns, or entire namespaces via the Admin API:

```bash
POST /api/admin/purge-cache
Content-Type: application/json
Authorization: Bearer <ADMIN_API_KEY_RAW>

{"namespace": "attestation", "key": "id:123"}
```

For a simpler, namespace-only clear, use the `/reset-cache` endpoint:

```bash
POST /api/admin/reset-cache
Content-Type: application/json
Authorization: Bearer <ADMIN_API_KEY_RAW>

{"namespace": "attestation"}
```

For full request/response details and audit logging behavior, see [docs/admin-api.md](admin-api.md#purge-cache) and [docs/admin-api.md](admin-api.md#reset-cache).

