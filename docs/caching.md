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

## Best Practices

1. **Always set TTL** - Prevent memory leaks
2. **Use namespaces** - Avoid key collisions
3. **Handle failures** - Always check return values
4. **Monitor health** - Use health checks in production
5. **Test failures** - Verify graceful degradation
6. **Document TTLs** - Clear cache invalidation strategy
7. **Size limits** - Avoid caching very large objects
8. **Consistent patterns** - Standardize key naming
