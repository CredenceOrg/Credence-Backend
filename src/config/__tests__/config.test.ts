import { describe, it, expect } from 'vitest'
import { validateConfig, ConfigValidationError, envSchema } from '../index.js'
import { RETRY_POLICY_HARD_CAPS } from '../../lib/retryPolicy.js'

/** Minimal valid env object reused across tests. */
function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PORT: '3000',
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    DB_URL: 'postgresql://user:pass@localhost:5432/credence',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'a]r$8kL!qZ3wX#mN9pT&vB6yD0fH2jU4',
    JWT_EXPIRY: '1h',
    ENABLE_TRUST_SCORING: 'false',
    ENABLE_BOND_EVENTS: 'false',
    CORS_ORIGIN: '*',
    ...overrides,
  }
}

// ─── Valid configurations ────────────────────────────────────────────────────

describe('validateConfig – valid environments', () => {
  it('returns a typed config object with all required vars', () => {
    const config = validateConfig(validEnv())

    expect(config.port).toBe(3000)
    expect(config.nodeEnv).toBe('development')
    expect(config.logLevel).toBe('info')
    expect(config.db.url).toBe('postgresql://user:pass@localhost:5432/credence')
    expect(config.redis.url).toBe('redis://localhost:6379')
    expect(config.jwt.secret).toBe('a]r$8kL!qZ3wX#mN9pT&vB6yD0fH2jU4')
    expect(config.jwt.expiry).toBe('1h')
    expect(config.features.trustScoring).toBe(false)
    expect(config.features.bondEvents).toBe(false)
    expect(config.cors.origin).toBe('*')
    expect(config.horizon).toBeUndefined()
  })

  it('applies defaults when optional fields are omitted', () => {
    const minimal = {
      DB_URL: 'postgresql://localhost:5432/credence',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a]r$8kL!qZ3wX#mN9pT&vB6yD0fH2jU4',
    }
    const config = validateConfig(minimal)

    expect(config.port).toBe(3000)
    expect(config.nodeEnv).toBe('development')
    expect(config.logLevel).toBe('info')
    expect(config.jwt.expiry).toBe('1h')
    expect(config.jwt.jwksCacheMaxAgeSeconds).toBe(300)
    expect(config.features.trustScoring).toBe(false)
    expect(config.features.bondEvents).toBe(false)
    expect(config.cors.origin).toBe('*')
  })

  it('parses custom PORT as number', () => {
    const config = validateConfig(validEnv({ PORT: '8080' }))
    expect(config.port).toBe(8080)
  })

  it('supports production NODE_ENV', () => {
    const config = validateConfig(validEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.credence.io' }))
    expect(config.nodeEnv).toBe('production')
  })

  it('supports test NODE_ENV', () => {
    const config = validateConfig(validEnv({ NODE_ENV: 'test' }))
    expect(config.nodeEnv).toBe('test')
  })

  it('parses all LOG_LEVEL values', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const config = validateConfig(validEnv({ LOG_LEVEL: level }))
      expect(config.logLevel).toBe(level)
    }
  })

  it('parses feature flags as booleans', () => {
    const config = validateConfig(
      validEnv({ ENABLE_TRUST_SCORING: 'true', ENABLE_BOND_EVENTS: 'true' }),
    )
    expect(config.features.trustScoring).toBe(true)
    expect(config.features.bondEvents).toBe(true)
  })

  it('includes horizon config when HORIZON_URL is set', () => {
    const config = validateConfig(
      validEnv({ HORIZON_URL: 'https://horizon-testnet.stellar.org' }),
    )
    expect(config.horizon).toEqual({ url: 'https://horizon-testnet.stellar.org' })
  })

  it('parses custom CORS_ORIGIN', () => {
    const config = validateConfig(validEnv({ CORS_ORIGIN: 'https://app.credence.io' }))
    expect(config.cors.origin).toBe('https://app.credence.io')
  })

  it('accepts custom JWT_EXPIRY', () => {
    const config = validateConfig(validEnv({ JWT_EXPIRY: '7d' }))
    expect(config.jwt.expiry).toBe('7d')
  })

  it('accepts custom JWKS_CACHE_MAX_AGE_SECONDS', () => {
    const config = validateConfig(validEnv({ JWKS_CACHE_MAX_AGE_SECONDS: '600' }))
    expect(config.jwt.jwksCacheMaxAgeSeconds).toBe(600)
  })

  it('applies outbound retry defaults when env overrides are omitted', () => {
    const config = validateConfig(validEnv())

    expect(config.outboundHttp.retry.defaults.maxAttempts).toBe(3)
    expect(config.outboundHttp.retry.defaults.baseDelayMs).toBe(200)
    expect(config.outboundHttp.retry.defaults.maxDelayMs).toBe(2000)
    expect(config.outboundHttp.retry.defaults.backoffMultiplier).toBe(2)
    expect(config.outboundHttp.retry.defaults.jitterStrategy).toBe('none')
  })

  it('defaults DB_POOL_IDLE_TIMEOUT_MS to 300 000 ms (5 minutes) when unset', () => {
    // Ensures idle connections are evicted after 5 min by default (#724)
    const config = validateConfig(validEnv())
    expect(config.db.pool.idleTimeoutMillis).toBe(300_000)
  })

  it('accepts a custom DB_POOL_IDLE_TIMEOUT_MS value', () => {
    const config = validateConfig(validEnv({ DB_POOL_IDLE_TIMEOUT_MS: '60000' }))
    expect(config.db.pool.idleTimeoutMillis).toBe(60_000)
  })

  it('supports provider-specific outbound retry overrides', () => {
    const config = validateConfig(
      validEnv({
        OUTBOUND_RETRY_SOROBAN_MAX_ATTEMPTS: '5',
        OUTBOUND_RETRY_SOROBAN_BASE_DELAY_MS: '750',
        OUTBOUND_RETRY_SOROBAN_JITTER_STRATEGY: 'full',
        OUTBOUND_RETRY_WEBHOOK_MAX_ATTEMPTS: '2',
        OUTBOUND_RETRY_WEBHOOK_BASE_DELAY_MS: '1500',
        OUTBOUND_RETRY_WEBHOOK_JITTER_STRATEGY: 'equal',
      }),
    )

    expect(config.outboundHttp.retry.providers!.soroban).toMatchObject({
      maxAttempts: 5,
      baseDelayMs: 750,
      jitterStrategy: 'full',
    })
    expect(config.outboundHttp.retry.providers!.webhook).toMatchObject({
      maxAttempts: 2,
      baseDelayMs: 1500,
      jitterStrategy: 'equal',
    })
  })

  it('enforces hard caps on outbound retry defaults', () => {
    const config = validateConfig(
      validEnv({
        OUTBOUND_RETRY_MAX_ATTEMPTS: '999',
        OUTBOUND_RETRY_BASE_DELAY_MS: '9999999',
        OUTBOUND_RETRY_MAX_DELAY_MS: '9999999',
        OUTBOUND_RETRY_BACKOFF_MULTIPLIER: '999',
      }),
    )

    expect(config.outboundHttp.retry.defaults.maxAttempts).toBe(RETRY_POLICY_HARD_CAPS.maxAttempts)
    expect(config.outboundHttp.retry.defaults.baseDelayMs).toBe(RETRY_POLICY_HARD_CAPS.baseDelayMs)
    expect(config.outboundHttp.retry.defaults.maxDelayMs).toBe(RETRY_POLICY_HARD_CAPS.maxDelayMs)
    expect(config.outboundHttp.retry.defaults.backoffMultiplier).toBe(
      RETRY_POLICY_HARD_CAPS.backoffMultiplier,
    )
  })
})

// ─── Missing required variables ──────────────────────────────────────────────

describe('validateConfig – missing required variables', () => {
  it('throws ConfigValidationError when DB_URL is missing', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).DB_URL

    expect(() => validateConfig(env)).toThrow(ConfigValidationError)
  })

  it('throws ConfigValidationError when REDIS_URL is missing', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).REDIS_URL

    expect(() => validateConfig(env)).toThrow(ConfigValidationError)
  })

  it('throws ConfigValidationError when JWT_SECRET is missing', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).JWT_SECRET

    expect(() => validateConfig(env)).toThrow(ConfigValidationError)
  })

  it('throws with all missing fields reported at once', () => {
    try {
      validateConfig({})
      expect.fail('Expected ConfigValidationError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError)
      const error = err as ConfigValidationError
      const paths = error.issues.map((i) => i.path[0])
      expect(paths).toContain('DB_URL')
      expect(paths).toContain('REDIS_URL')
      expect(paths).toContain('JWT_SECRET')
    }
  })
})

// ─── Invalid values ──────────────────────────────────────────────────────────

describe('validateConfig – invalid values', () => {
  it('rejects invalid DB_URL', () => {
    expect(() => validateConfig(validEnv({ DB_URL: 'not-a-url' }))).toThrow(
      ConfigValidationError,
    )
  })

  it('rejects invalid REDIS_URL', () => {
    expect(() => validateConfig(validEnv({ REDIS_URL: 'not-a-url' }))).toThrow(
      ConfigValidationError,
    )
  })

  it('rejects JWT_SECRET shorter than 32 characters', () => {
    expect(() => validateConfig(validEnv({ JWT_SECRET: 'short' }))).toThrow(
      ConfigValidationError,
    )
  })

  it('rejects invalid NODE_ENV', () => {
    expect(() => validateConfig(validEnv({ NODE_ENV: 'staging' }))).toThrow(
      ConfigValidationError,
    )
  })

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => validateConfig(validEnv({ LOG_LEVEL: 'verbose' }))).toThrow(
      ConfigValidationError,
    )
  })

  it('rejects PORT out of range (0)', () => {
    expect(() => validateConfig(validEnv({ PORT: '0' }))).toThrow(
      ConfigValidationError,
    )
  })

  it('rejects PORT out of range (70000)', () => {
    expect(() => validateConfig(validEnv({ PORT: '70000' }))).toThrow(
      ConfigValidationError,
    )
  })

  it('rejects non-numeric PORT', () => {
    expect(() => validateConfig(validEnv({ PORT: 'abc' }))).toThrow(
      ConfigValidationError,
    )
  })

  it('rejects invalid HORIZON_URL when provided', () => {
    expect(() =>
      validateConfig(validEnv({ HORIZON_URL: 'not-a-url' })),
    ).toThrow(ConfigValidationError)
  })

  it('rejects wildcard CORS origin (*) when NODE_ENV is production', () => {
    expect(() =>
      validateConfig(validEnv({ NODE_ENV: 'production', CORS_ORIGIN: '*' })),
    ).toThrow(ConfigValidationError)
  })
})

// ─── Database replica pool config (#887) ─────────────────────────────────────

describe('validateConfig – database replica pool', () => {
  it('falls back replicaPool.max to DB_POOL_MAX when DB_REPLICA_POOL_MAX is unset', () => {
    const config = validateConfig(validEnv({ DB_POOL_MAX: '35' }))
    expect(config.db.replicaPool.max).toBe(35)
  })

  it('uses DB_REPLICA_POOL_MAX when explicitly set, independent of DB_POOL_MAX', () => {
    const config = validateConfig(validEnv({ DB_POOL_MAX: '20', DB_REPLICA_POOL_MAX: '8' }))
    expect(config.db.pool.max).toBe(20)
    expect(config.db.replicaPool.max).toBe(8)
  })

  it('rejects a DB_REPLICA_POOL_MAX outside the 1-200 range (failure mode)', () => {
    expect(() => validateConfig(validEnv({ DB_REPLICA_POOL_MAX: '0' }))).toThrow(ConfigValidationError)
    expect(() => validateConfig(validEnv({ DB_REPLICA_POOL_MAX: '500' }))).toThrow(ConfigValidationError)
  })

  it('defaults maxReplicaLagMs to 1000ms when MAX_REPLICA_LAG_MS is unset', () => {
    const config = validateConfig(validEnv())
    expect(config.db.maxReplicaLagMs).toBe(1000)
  })

  it('honors an explicit MAX_REPLICA_LAG_MS override', () => {
    const config = validateConfig(validEnv({ MAX_REPLICA_LAG_MS: '2500' }))
    expect(config.db.maxReplicaLagMs).toBe(2500)
  })
})

// ─── ConfigValidationError ───────────────────────────────────────────────────

describe('ConfigValidationError', () => {
  it('has descriptive message with field names', () => {
    try {
      validateConfig({})
      expect.fail('Expected error')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError)
      const error = err as ConfigValidationError
      expect(error.message).toContain('Environment validation failed')
      expect(error.message).toContain('DB_URL')
      expect(error.name).toBe('ConfigValidationError')
    }
  })

  it('exposes raw Zod issues', () => {
    try {
      validateConfig({})
      expect.fail('Expected error')
    } catch (err) {
      const error = err as ConfigValidationError
      expect(Array.isArray(error.issues)).toBe(true)
      expect(error.issues.length).toBeGreaterThan(0)
    }
  })
})

// ─── envSchema export ────────────────────────────────────────────────────────

describe('envSchema', () => {
  it('is exported and usable directly', () => {
    const result = envSchema.safeParse(validEnv())
    expect(result.success).toBe(true)
  })
})

// ─── Bond / attestation cache TTL ────────────────────────────────────────────

describe('validateConfig – bond/attestation cache TTL', () => {
  it('defaults bondCache.ttl and attestationCache.ttl to 300 seconds', () => {
    const config = validateConfig(validEnv())

    expect(config.bondCache.ttl).toBe(300)
    expect(config.attestationCache.ttl).toBe(300)
  })

  it('applies BOND_CACHE_TTL_SECONDS and ATTESTATION_CACHE_TTL_SECONDS overrides', () => {
    const config = validateConfig(validEnv({
      BOND_CACHE_TTL_SECONDS: '900',
      ATTESTATION_CACHE_TTL_SECONDS: '120',
    }))

    expect(config.bondCache.ttl).toBe(900)
    expect(config.attestationCache.ttl).toBe(120)
  })

  it('rejects a non-numeric BOND_CACHE_TTL_SECONDS', () => {
    expect(() =>
      validateConfig(validEnv({ BOND_CACHE_TTL_SECONDS: 'not-a-number' })),
    ).toThrow(ConfigValidationError)
  })

  it('rejects an out-of-range ATTESTATION_CACHE_TTL_SECONDS', () => {
    expect(() =>
      validateConfig(validEnv({ ATTESTATION_CACHE_TTL_SECONDS: '999999' })),
    ).toThrow(ConfigValidationError)
  })
})
