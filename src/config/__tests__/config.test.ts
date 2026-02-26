import { describe, it, expect } from 'vitest'
import { validateConfig, ConfigValidationError, envSchema } from '../index.js'

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
    expect(config.features.trustScoring).toBe(false)
    expect(config.features.bondEvents).toBe(false)
    expect(config.cors.origin).toBe('*')
  })

  it('parses custom PORT as number', () => {
    const config = validateConfig(validEnv({ PORT: '8080' }))
    expect(config.port).toBe(8080)
  })

  it('supports production NODE_ENV', () => {
    const config = validateConfig(validEnv({ NODE_ENV: 'production' }))
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
