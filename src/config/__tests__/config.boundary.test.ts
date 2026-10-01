/**
 * Boundary and recovery coverage for the environment configuration module.
 *
 * `src/config/index.ts` is the process-wide gate every request depends on: a
 * bad value here either refuses to boot or, worse, boots with a silently
 * degraded safeguard. These tests pin the edges of that gate — numeric ranges,
 * blank/non-numeric coercion, the billing cost-weight parser, the JWT secret
 * rules, the fail-open default, and the `loadConfig` failure path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  validateConfig,
  loadConfig,
  envSchema,
  ConfigValidationError,
} from '../index.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_JWT_SECRET = 'a]r$8kL!qZ3wX#mN9pT&vB6yD0fH2jU4'

/** Minimal env that passes validation, extended per-test. */
function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DB_URL: 'postgresql://user:pass@localhost:5432/credence',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: VALID_JWT_SECRET,
    ...overrides,
  }
}

/** Returns the ConfigValidationError message, or null if validation succeeded. */
function rejectionMessage(overrides: Record<string, string>): string | null {
  try {
    validateConfig(validEnv(overrides))
    return null
  } catch (err) {
    return err instanceof ConfigValidationError ? err.message : `NON_CONFIG_ERROR:${String(err)}`
  }
}

function accepts(overrides: Record<string, string>): boolean {
  return rejectionMessage(overrides) === null
}

/**
 * Numeric fields and their declared bounds, mirroring the env schema.
 *
 * `int: false` marks fields validated with a plain min/max (not `.int()`), which
 * legitimately accept fractional values.
 */
const NUMERIC_FIELDS: Array<{
  key: string
  min: number
  max?: number
  int: boolean
  optional?: boolean
}> = [
  { key: 'TRUST_SCORE_CACHE_TTL', min: 60, max: 86_400, int: true },
  { key: 'WEBHOOK_PAYLOAD_SIZE_CAP', min: 1024, max: 10_485_760, int: true },
  { key: 'PORT', min: 1, max: 65_535, int: true },
  { key: 'DB_POOL_MAX', min: 1, max: 200, int: true },
  { key: 'DB_POOL_IDLE_TIMEOUT_MS', min: 0, int: true },
  { key: 'DB_POOL_CONNECTION_TIMEOUT_MS', min: 1000, max: 30_000, int: true },
  { key: 'DB_STATEMENT_TIMEOUT_MS', min: 0, int: true },
  { key: 'DB_WORKER_POOL_MAX', min: 1, max: 50, int: true },
  { key: 'DB_LOCK_TIMEOUT_READONLY_MS', min: 100, max: 30_000, int: true },
  { key: 'DB_LOCK_TIMEOUT_DEFAULT_MS', min: 100, max: 30_000, int: true },
  { key: 'DB_LOCK_TIMEOUT_CRITICAL_MS', min: 100, max: 60_000, int: true },
  { key: 'KEY_ROTATION_INTERVAL_SECONDS', min: 1, int: true },
  { key: 'KEY_GRACE_PERIOD_SECONDS', min: 0, int: true },
  { key: 'KEY_CLOCK_SKEW_SECONDS', min: 0, int: true },
  { key: 'OUTBOX_POLL_INTERVAL_MS', min: 100, int: true },
  { key: 'OUTBOX_BATCH_SIZE', min: 1, int: true },
  { key: 'OUTBOX_PUBLISHED_RETENTION_DAYS', min: 1, int: true },
  { key: 'OUTBOX_FAILED_RETENTION_DAYS', min: 1, int: true },
  { key: 'OUTBOX_CLEANUP_INTERVAL_MS', min: 60_000, int: true },
  { key: 'REQUEST_SNAPSHOT_RETENTION_DAYS', min: 1, int: true },
  { key: 'REQUEST_SNAPSHOT_CLEANUP_INTERVAL_MS', min: 60_000, int: true },
  { key: 'SHUTDOWN_GRACE_PERIOD_MS', min: 1000, int: true },
  { key: 'OUTBOUND_RETRY_MAX_ATTEMPTS', min: 1, int: true },
  { key: 'OUTBOUND_RETRY_BASE_DELAY_MS', min: 1, int: true },
  { key: 'OUTBOUND_RETRY_MAX_DELAY_MS', min: 1, int: true },
  { key: 'OUTBOUND_RETRY_BACKOFF_MULTIPLIER', min: 1, int: false },
  { key: 'OUTBOUND_RETRY_SOROBAN_MAX_ATTEMPTS', min: 1, int: true, optional: true },
  { key: 'OUTBOUND_RETRY_SOROBAN_BASE_DELAY_MS', min: 1, int: true, optional: true },
  { key: 'OUTBOUND_RETRY_SOROBAN_MAX_DELAY_MS', min: 1, int: true, optional: true },
  { key: 'OUTBOUND_RETRY_SOROBAN_BACKOFF_MULTIPLIER', min: 1, int: false, optional: true },
  { key: 'OUTBOUND_RETRY_WEBHOOK_MAX_ATTEMPTS', min: 1, int: true, optional: true },
  { key: 'OUTBOUND_RETRY_WEBHOOK_BASE_DELAY_MS', min: 1, int: true, optional: true },
  { key: 'OUTBOUND_RETRY_WEBHOOK_MAX_DELAY_MS', min: 1, int: true, optional: true },
  { key: 'OUTBOUND_RETRY_WEBHOOK_BACKOFF_MULTIPLIER', min: 1, int: false, optional: true },
  { key: 'TIMEOUT_DB_MS', min: 100, max: 30_000, int: true },
  { key: 'TIMEOUT_CACHE_MS', min: 50, max: 10_000, int: true },
  { key: 'TIMEOUT_QUEUE_MS', min: 100, max: 15_000, int: true },
  { key: 'TIMEOUT_HTTP_MS', min: 1000, max: 60_000, int: true },
  { key: 'TIMEOUT_SOROBAN_MS', min: 100, max: 45_000, int: true },
  { key: 'TIMEOUT_WEBHOOK_MS', min: 2000, max: 60_000, int: true },
  { key: 'RATE_LIMIT_WINDOW_SEC', min: 1, max: 3600, int: true },
  { key: 'RATE_LIMIT_MAX_FREE', min: 1, int: true },
  { key: 'RATE_LIMIT_MAX_PRO', min: 1, int: true },
  { key: 'RATE_LIMIT_MAX_ENTERPRISE', min: 1, int: true },
  { key: 'DEFAULT_MONTHLY_CREDITS', min: 0, int: true },
  { key: 'REPUTATION_BOND_SCORE_MAX', min: 0, max: 100, int: false },
  { key: 'REPUTATION_DURATION_SCORE_MAX', min: 0, max: 100, int: false },
  { key: 'REPUTATION_ATTESTATION_SCORE_MAX', min: 0, max: 100, int: false },
  { key: 'REPUTATION_MAX_DURATION_DAYS', min: 1, int: true },
  { key: 'REPUTATION_MAX_ATTESTATION_COUNT', min: 1, int: true },
  { key: 'SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD', min: 1, int: true },
  { key: 'SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS', min: 1000, int: true },
  { key: 'AUDIT_EXPORT_MAX_WINDOW_DAYS', min: 1, max: 3650, int: true },
  { key: 'REPORT_MAX_CONCURRENT_JOBS_PER_ORG', min: 0, max: 1000, int: true },
]

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Numeric field boundaries ─────────────────────────────────────────────────

describe('numeric env fields — declared bound boundaries', () => {
  for (const field of NUMERIC_FIELDS) {
    const { key, min, max, int } = field

    it(`${key} accepts its minimum (${min})`, () => {
      expect(accepts({ [key]: String(min) })).toBe(true)
    })

    it(`${key} rejects below its minimum (${min - 1})`, () => {
      expect(accepts({ [key]: String(min - 1) })).toBe(false)
    })

    if (max !== undefined) {
      it(`${key} accepts its maximum (${max})`, () => {
        expect(accepts({ [key]: String(max) })).toBe(true)
      })

      it(`${key} rejects above its maximum (${max + 1})`, () => {
        expect(accepts({ [key]: String(max + 1) })).toBe(false)
      })
    }

    if (int) {
      it(`${key} rejects a fractional value`, () => {
        expect(accepts({ [key]: '1.5' })).toBe(false)
      })
    } else {
      it(`${key} accepts a fractional value`, () => {
        expect(accepts({ [key]: '1.5' })).toBe(true)
      })
    }
  }
})

describe('numeric env fields — malformed input', () => {
  for (const field of NUMERIC_FIELDS) {
    const { key } = field

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['non-numeric text', 'abc'],
      ['partially numeric', '10abc'],
      ['trailing unit', '10ms'],
      ['Infinity', 'Infinity'],
      ['NaN', 'NaN'],
      ['a decimal point only', '.'],
      ['a lone minus sign', '-'],
    ])(`${key} rejects %s`, (_label, value) => {
      // A blank or unparseable value must fail loudly. Coercing it to 0 would
      // silently disable whatever safeguard the field guards.
      expect(accepts({ [key]: value })).toBe(false)
    })
  }
})

describe('numeric env fields — alternative JS numeric notation', () => {
  // Number() accepts hex and exponent forms. These are well-defined rather than
  // malformed, so they are accepted when they land inside the field's bounds
  // and rejected when they land outside — the bounds, not the notation, decide.
  for (const field of NUMERIC_FIELDS.filter((f) => f.min > 0 && f.max !== undefined)) {
    const { key, min, max } = field
    // Re-express the field's own minimum in each notation so the value is
    // guaranteed to sit inside its bounds.
    const hexMin = `0x${min.toString(16)}`
    const expMin = min.toString().length > 1
      ? `${min.toString()[0]}.${min.toString().slice(1)}e${min.toString().length - 1}`
      : `1e${min}`

    it(`${key} accepts ${hexMin} (its minimum in hex form)`, () => {
      expect(accepts({ [key]: hexMin })).toBe(true)
    })

    it(`${key} rejects a hex value above its maximum`, () => {
      expect(accepts({ [key]: `0x${(max + 1).toString(16)}` })).toBe(false)
    })

    it(`${key} accepts ${expMin} (its minimum in exponent form)`, () => {
      expect(accepts({ [key]: expMin })).toBe(true)
    })

    it(`${key} rejects an exponent value above its maximum`, () => {
      expect(accepts({ [key]: `1e${String(max).length}` })).toBe(false)
    })
  }
})

describe('numeric env fields — zero is only valid where the bound allows it', () => {
  const zeroBounded = NUMERIC_FIELDS.filter((f) => f.min === 0).map((f) => f.key)

  it('covers exactly the fields whose lower bound is 0', () => {
    expect(zeroBounded).toEqual([
      'DB_POOL_IDLE_TIMEOUT_MS',
      'DB_STATEMENT_TIMEOUT_MS',
      'KEY_GRACE_PERIOD_SECONDS',
      'KEY_CLOCK_SKEW_SECONDS',
      'DEFAULT_MONTHLY_CREDITS',
      'REPUTATION_BOND_SCORE_MAX',
      'REPUTATION_DURATION_SCORE_MAX',
      'REPUTATION_ATTESTATION_SCORE_MAX',
      'REPORT_MAX_CONCURRENT_JOBS_PER_ORG',
    ])
  })

  it('accepts an explicit "0" for zero-bounded fields', () => {
    for (const key of zeroBounded) {
      expect(accepts({ [key]: '0' })).toBe(true)
    }
  })

  it('rejects "0" for every field bounded above zero', () => {
    for (const field of NUMERIC_FIELDS.filter((f) => f.min > 0)) {
      expect(accepts({ [field.key]: '0' })).toBe(false)
    }
  })

  it('rejects negatives for every numeric field', () => {
    for (const field of NUMERIC_FIELDS) {
      expect(accepts({ [field.key]: '-1' })).toBe(false)
    }
  })
})

// ─── Optional-field presence ─────────────────────────────────────────────────

describe('optional env fields', () => {
  it('accepts the env with all optional fields omitted', () => {
    expect(accepts({})).toBe(true)
  })

  for (const field of NUMERIC_FIELDS.filter((f) => f.optional)) {
    it(`${field.key} may be omitted`, () => {
      expect(accepts({})).toBe(true)
    })
  }

  it('treats KEY_PRIVATE_PEM as optional and passes it through verbatim', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n'
    const config = validateConfig(validEnv({ KEY_PRIVATE_PEM: pem }))

    expect(config.jwt.privateKeyPem).toBe(pem)
  })

  it('passes KEY_INITIAL_KID through verbatim', () => {
    expect(validateConfig(validEnv({ KEY_INITIAL_KID: 'kid-2026-01' })).jwt.initialKid).toBe(
      'kid-2026-01',
    )
  })

  it('leaves both key-source fields undefined when absent', () => {
    const config = validateConfig(validEnv())

    expect(config.jwt.privateKeyPem).toBeUndefined()
    expect(config.jwt.initialKid).toBeUndefined()
  })

  it('omits the horizon block when HORIZON_URL is absent', () => {
    expect(validateConfig(validEnv()).horizon).toBeUndefined()
  })

  it('includes the horizon block when HORIZON_URL is valid', () => {
    const config = validateConfig(validEnv({ HORIZON_URL: 'https://horizon.stellar.org' }))

    expect(config.horizon).toEqual({ url: 'https://horizon.stellar.org' })
  })

  it('rejects an empty HORIZON_URL rather than treating it as absent', () => {
    expect(accepts({ HORIZON_URL: '' })).toBe(false)
  })
})

// ─── Boolean flag parsing ─────────────────────────────────────────────────────

describe('boolean env flags', () => {
  /**
   * Reads the Config property each flag maps to, and the value it takes when
   * the env var is absent. Trust scoring and bond events are opt-in; the outbox
   * publisher and snapshot sweeper are opt-out.
   */
  const FLAG_READERS: Record<string, { read: (e: Record<string, string>) => boolean; absent: boolean }> = {
    ENABLE_TRUST_SCORING: { read: (e) => validateConfig(e).features.trustScoring, absent: false },
    ENABLE_BOND_EVENTS: { read: (e) => validateConfig(e).features.bondEvents, absent: false },
    OUTBOX_ENABLED: { read: (e) => validateConfig(e).outbox.enabled, absent: true },
    REQUEST_SNAPSHOT_CLEANUP_ENABLED: {
      read: (e) => validateConfig(e).requestSnapshots.cleanupEnabled,
      absent: true,
    },
  }

  const FLAGS = Object.keys(FLAG_READERS)

  it('covers every boolean flag in the schema', () => {
    expect(FLAGS).toEqual([
      'ENABLE_TRUST_SCORING',
      'ENABLE_BOND_EVENTS',
      'OUTBOX_ENABLED',
      'REQUEST_SNAPSHOT_CLEANUP_ENABLED',
    ])
  })

  for (const flag of FLAGS) {
    const { read, absent } = FLAG_READERS[flag]

    it(`${flag} parses "true" as true`, () => {
      expect(read(validEnv({ [flag]: 'true' }))).toBe(true)
    })

    it(`${flag} parses "false" as false`, () => {
      expect(read(validEnv({ [flag]: 'false' }))).toBe(false)
    })

    it(`${flag} defaults to ${absent} when absent`, () => {
      expect(read(validEnv())).toBe(absent)
    })

    it.each(['TRUE', '1', 'yes', 'on', '0', 'no', 'false '])(
      `${flag} treats %j as false`,
      (value) => {
        // Only the exact literal "true" enables a flag, so a near-miss must not
        // silently turn a feature on.
        expect(read(validEnv({ [flag]: value }))).toBe(false)
      },
    )
  }

  it('maps each flag onto its own config section without cross-talk', () => {
    const config = validateConfig(
      validEnv({
        ENABLE_TRUST_SCORING: 'true',
        ENABLE_BOND_EVENTS: 'true',
        OUTBOX_ENABLED: 'true',
        REQUEST_SNAPSHOT_CLEANUP_ENABLED: 'false',
      }),
    )

    expect(config.features.trustScoring).toBe(true)
    expect(config.features.bondEvents).toBe(true)
    expect(config.outbox.enabled).toBe(true)
    expect(config.requestSnapshots.cleanupEnabled).toBe(false)
  })

  it('keeps feature flags independent of each other', () => {
    const config = validateConfig(validEnv({ ENABLE_TRUST_SCORING: 'true' }))

    expect(config.features.trustScoring).toBe(true)
    expect(config.features.bondEvents).toBe(false)
  })
})

// ─── RATE_LIMIT_FAIL_OPEN determinism ─────────────────────────────────────────

describe('RATE_LIMIT_FAIL_OPEN resolution', () => {
  const ambient = { key: 'NODE_ENV' as const }

  afterEach(() => {
    process.env[ambient.key] = undefined
  })

  it('fails closed in production when the flag is unset', () => {
    const config = validateConfig(validEnv({ NODE_ENV: 'production' }))

    // Fail-closed in production is the safe default: when the rate-limit store
    // is unreachable, traffic must not be waved through unbounded.
    expect(config.rateLimit.failOpen).toBe(false)
  })

  it('fails open outside production when the flag is unset', () => {
    expect(validateConfig(validEnv({ NODE_ENV: 'development' })).rateLimit.failOpen).toBe(true)
    expect(validateConfig(validEnv({ NODE_ENV: 'test' })).rateLimit.failOpen).toBe(true)
  })

  it('derives failOpen from the passed env, not ambient process.env', () => {
    // Regression: the schema transform used to read `process.env.NODE_ENV`
    // directly, so a production config validated while the process happened to
    // be running with NODE_ENV=development silently failed OPEN.
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      expect(validateConfig(validEnv({ NODE_ENV: 'production' })).rateLimit.failOpen).toBe(false)
      expect(validateConfig(validEnv({ NODE_ENV: 'development' })).rateLimit.failOpen).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
    }
  })

  it('is stable regardless of ambient NODE_ENV', () => {
    const results = new Set<boolean>()
    for (const value of ['production', 'development', 'test', undefined]) {
      const previous = process.env.NODE_ENV
      if (value === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = value
      try {
        results.add(validateConfig(validEnv({ NODE_ENV: 'production' })).rateLimit.failOpen)
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previous
      }
    }

    expect(results).toEqual(new Set([false]))
  })

  it('lets an explicit "false" override the production default', () => {
    const config = validateConfig(
      validEnv({ NODE_ENV: 'production', RATE_LIMIT_FAIL_OPEN: 'false' }),
    )

    expect(config.rateLimit.failOpen).toBe(false)
  })

  it('lets an explicit "true" override the production default', () => {
    const config = validateConfig(
      validEnv({ NODE_ENV: 'production', RATE_LIMIT_FAIL_OPEN: 'true' }),
    )

    expect(config.rateLimit.failOpen).toBe(true)
  })

  it.each(['TRUE', '1', 'yes', 'garbage'])(
    'treats an explicit non-"true" flag %j as fail-closed',
    (value) => {
      const config = validateConfig(
        validEnv({ NODE_ENV: 'production', RATE_LIMIT_FAIL_OPEN: value }),
      )

      expect(config.rateLimit.failOpen).toBe(false)
    },
  )
})

// ─── JWT secret boundaries ────────────────────────────────────────────────────

describe('JWT_SECRET boundaries', () => {
  it('accepts exactly 32 characters', () => {
    expect(rejectionMessage({ JWT_SECRET: 'a'.repeat(32) })).toBeNull()
  })

  it('rejects 31 characters', () => {
    expect(rejectionMessage({ JWT_SECRET: 'a'.repeat(31) })).not.toBeNull()
  })

  it('rejects an empty secret', () => {
    expect(rejectionMessage({ JWT_SECRET: '' })).not.toBeNull()
  })

  it('rejects a whitespace-only secret of valid length', () => {
    // Length alone is not enough: a blank 32-character secret is trivially
    // guessable and would be used to sign every issued token.
    expect(rejectionMessage({ JWT_SECRET: ' '.repeat(32) })).not.toBeNull()
  })

  it('rejects a tab/newline-only secret of valid length', () => {
    expect(rejectionMessage({ JWT_SECRET: '\t\n'.repeat(16) })).not.toBeNull()
  })

  it('accepts a secret with surrounding whitespace but real content', () => {
    expect(rejectionMessage({ JWT_SECRET: `  ${'a'.repeat(32)}  ` })).toBeNull()
  })

  it('reports the length failure without echoing the secret', () => {
    const secret = 'sup3r-s3cret-too-short'
    const message = rejectionMessage({ JWT_SECRET: secret })

    expect(message).toContain('JWT_SECRET')
    expect(message).toContain('at least 32 characters')
    expect(message).not.toContain(secret)
    expect(message).not.toContain('sup3r')
  })
})

// ─── REPUTATION_ONE_ETH_WEI boundaries ───────────────────────────────────────

describe('REPUTATION_ONE_ETH_WEI boundaries', () => {
  it('defaults to 10^18 wei', () => {
    expect(validateConfig(validEnv()).reputation.oneEthWei).toBe(10n ** 18n)
  })

  it('accepts 1 wei as the smallest positive value', () => {
    expect(validateConfig(validEnv({ REPUTATION_ONE_ETH_WEI: '1' })).reputation.oneEthWei).toBe(1n)
  })

  it.each([
    ['zero', '0'],
    ['negative', '-1000000000000000000'],
    ['minus one', '-1'],
    ['non-numeric', 'abc'],
    ['fractional', '1.5'],
    ['empty', ''],
  ])('rejects a %s value', (_label, value) => {
    // This value is the divisor in wei→ETH trust-score math. Zero yields
    // Infinity/NaN and a negative inverts the bond component, corrupting every
    // score rather than failing at boot.
    expect(rejectionMessage({ REPUTATION_ONE_ETH_WEI: value })).not.toBeNull()
  })

  it('accepts a hex literal, which BigInt parses as a positive integer', () => {
    expect(validateConfig(validEnv({ REPUTATION_ONE_ETH_WEI: '0x10' })).reputation.oneEthWei).toBe(
      16n,
    )
  })

  it('accepts an arbitrarily large positive value', () => {
    const huge = '9'.repeat(40)
    expect(validateConfig(validEnv({ REPUTATION_ONE_ETH_WEI: huge })).reputation.oneEthWei).toBe(
      BigInt(huge),
    )
  })
})

// ─── Cost weight parsing ──────────────────────────────────────────────────────

describe('ENDPOINT_COST_WEIGHTS parsing', () => {
  function weights(raw: string): Record<string, number> {
    return validateConfig(validEnv({ ENDPOINT_COST_WEIGHTS: raw })).endpointCostWeights
  }

  it('parses a well-formed map', () => {
    expect(weights('{"default":1,"/bulk/verify":10,"/reports":5}')).toEqual({
      default: 1,
      '/bulk/verify': 10,
      '/reports': 5,
    })
  })

  it('preserves a zero weight (a legitimately free endpoint)', () => {
    expect(weights('{"default":1,"/health":0}')).toEqual({ default: 1, '/health': 0 })
  })

  it('applies the default weight to an empty object', () => {
    expect(weights('{}')).toEqual({ default: 1 })
  })

  it.each([
    ['invalid JSON', 'not-json'],
    ['truncated JSON', '{"default":1'],
    ['empty string', ''],
    ['an array', '[1,2,3]'],
    ['a bare string', '"just-a-string"'],
    ['a bare number', '42'],
    ['null', 'null'],
  ])('falls back to the default weight for %s', (_label, raw) => {
    expect(weights(raw)).toEqual({ default: 1 })
  })

  it('discards a negative weight rather than crediting accounts', () => {
    // Weights are subtracted from credit balances; a negative weight would
    // *increase* the balance on every request.
    expect(weights('{"default":-5}')).toEqual({ default: 1 })
  })

  it.each([
    ['a string', '{"default":"abc"}'],
    ['null', '{"default":null}'],
    ['a boolean', '{"default":true}'],
    ['an array', '{"default":[1]}'],
    ['an object', '{"default":{"a":1}}'],
  ])('discards a %s weight', (_label, raw) => {
    expect(weights(raw)).toEqual({ default: 1 })
  })

  it('discards a NaN-producing weight', () => {
    expect(weights('{"default":1e999}')).toEqual({ default: 1 })
  })

  it('discards individual bad weights while keeping the valid ones', () => {
    expect(weights('{"default":2,"/good":5,"/bad":-1,"/alsogood":0}')).toEqual({
      default: 2,
      '/good': 5,
      '/alsogood': 0,
    })
  })

  it('always yields a numeric default', () => {
    // resolveCostWeight relies on `default` being present and numeric for any
    // path that matches no pattern.
    for (const raw of ['{}', 'not-json', '[1]', '{"default":-1}', '{"default":"x"}']) {
      const parsed = weights(raw)
      expect(typeof parsed.default).toBe('number')
      expect(Number.isFinite(parsed.default)).toBe(true)
      expect(parsed.default).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps endpoint weights that contain regex-significant characters', () => {
    expect(weights('{"default":1,"/v1/:id/verify":4}')).toEqual({
      default: 1,
      '/v1/:id/verify': 4,
    })
  })
})

// ─── Unknown and conflicting keys ────────────────────────────────────────────

describe('unknown and conflicting env keys', () => {
  it('ignores unknown keys rather than failing', () => {
    const config = validateConfig({
      ...validEnv(),
      TOTALLY_UNKNOWN_KEY: 'whatever',
    } as Record<string, string>)

    expect(config.port).toBe(3000)
  })

  it('ignores a lowercased key instead of using it as an override', () => {
    // Env keys are case-sensitive. A lowercase duplicate must not silently
    // shadow the canonical value, and must not satisfy a required field.
    const config = validateConfig({
      ...validEnv(),
      port: '8080',
    } as Record<string, string>)

    expect(config.port).toBe(3000)
  })

  it('does not let a lowercase required key satisfy the requirement', () => {
    const env = validEnv()
    delete env.DB_URL
    Object.assign(env, { db_url: 'postgresql://user:pass@localhost:5432/credence' })

    expect(() => validateConfig(env)).toThrow(ConfigValidationError)
  })

  it('lets the canonical key win when both cases are present', () => {
    const config = validateConfig({
      ...validEnv(),
      PORT: '8080',
      port: '9999',
    } as Record<string, string>)

    expect(config.port).toBe(8080)
  })

  it('treats an explicit undefined value as absent', () => {
    const config = validateConfig(validEnv({ HORIZON_URL: undefined } as never))

    expect(config.horizon).toBeUndefined()
  })
})

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('determinism and repeated evaluation', () => {
  it('produces an identical result for repeated calls with the same input', () => {
    const env = validEnv({ NODE_ENV: 'production', PORT: '4000' })

    const results = Array.from({ length: 25 }, () => validateConfig(env))

    for (const result of results) {
      expect(result).toEqual(results[0])
    }
  })

  it('is unaffected by concurrent calls with different envs', () => {
    const prod = validateConfig(validEnv({ NODE_ENV: 'production' }))
    const dev = validateConfig(validEnv({ NODE_ENV: 'development' }))

    const interleaved = Array.from({ length: 10 }, (_, i) =>
      validateConfig(validEnv({ NODE_ENV: i % 2 === 0 ? 'production' : 'development' })),
    )

    expect(prod.rateLimit.failOpen).toBe(false)
    expect(dev.rateLimit.failOpen).toBe(true)
    expect(interleaved.filter((_, i) => i % 2 === 0).every((c) => c.rateLimit.failOpen === false)).toBe(true)
    expect(interleaved.filter((_, i) => i % 2 === 1).every((c) => c.rateLimit.failOpen === true)).toBe(true)
  })

  it('does not mutate the input env object', () => {
    const env = validEnv()
    const snapshot = { ...env }

    validateConfig(env)

    expect(env).toEqual(snapshot)
  })

  it('never shares mutable state between returned configs', () => {
    const a = validateConfig(validEnv())
    const b = validateConfig(validEnv())

    a.endpointCostWeights.default = 999
    a.rateLimit.maxFree = 0

    expect(b.endpointCostWeights.default).toBe(1)
    expect(b.rateLimit.maxFree).toBe(100)
  })
})

// ─── Aggregate failure reporting ──────────────────────────────────────────────

describe('aggregate failure reporting', () => {
  it('reports every invalid field in a single error', () => {
    // A misconfigured deploy should learn about all its problems at once rather
    // than one per restart.
    const message = rejectionMessage({
      PORT: '99999',
      TIMEOUT_DB_MS: '1',
      SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS: '1',
    })

    expect(message).toContain('PORT')
    expect(message).toContain('TIMEOUT_DB_MS')
    expect(message).toContain('SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS')
  })

  it('exposes structured issues with a path per failure', () => {
    try {
      validateConfig(validEnv({ PORT: '99999' }))
      expect.fail('Expected ConfigValidationError')
    } catch (err) {
      const error = err as ConfigValidationError
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect(error.name).toBe('ConfigValidationError')
      expect(Array.isArray(error.issues)).toBe(true)
      const portIssue = error.issues.find((i) => i.path.join('.') === 'PORT')
      expect(portIssue).toBeDefined()
      expect(portIssue!.message).toEqual(expect.any(String))
    }
  })

  it('formats each issue on its own line with a readable prefix', () => {
    try {
      validateConfig(validEnv({ PORT: '99999', TIMEOUT_DB_MS: '1' }))
      expect.fail('Expected ConfigValidationError')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('Environment validation failed')
      const lines = message.split('\n').filter((l) => l.startsWith('  - '))
      expect(lines.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('never echoes secret material in the error message', () => {
    const password = 'sup3r-s3cret-pw'
    const dbUrl = `postgresql://admin:${password}@db.internal:5432/credence`
    const jwt = 'a-short-secret'
    let message = ''
    try {
      // A syntactically valid URL carrying a password, plus a too-short secret:
      // the secret is rejected, and neither value may appear in the output.
      validateConfig({ DB_URL: dbUrl, REDIS_URL: 'redis://localhost:6379', JWT_SECRET: jwt })
    } catch (err) {
      message = (err as Error).message
    }

    expect(message).toContain('JWT_SECRET')
    // Diagnostics must name the offending field without leaking its value.
    expect(message).not.toContain(password)
    expect(message).not.toContain(jwt)
    expect(message).not.toContain(dbUrl)
    expect(message).not.toContain('admin')
  })

  it('never echoes a rejected URL value', () => {
    const password = 'sup3r-s3cret-pw'
    const dbUrl = `postgresql://admin:${password}@not a url/credence`
    let message = ''
    try {
      validateConfig({
        DB_URL: dbUrl,
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'a'.repeat(32),
      })
    } catch (err) {
      message = (err as Error).message
    }

    expect(message).toContain('DB_URL')
    expect(message).toContain('valid URL')
    expect(message).not.toContain(password)
    expect(message).not.toContain(dbUrl)
  })

  it('names a missing required field instead of describing a type error', () => {
    // "expected string, received undefined" tells an operator nothing about
    // what to set at boot time.
    let message = ''
    try {
      validateConfig({})
    } catch (err) {
      message = (err as Error).message
    }

    expect(message).toContain('DB_URL is required')
    expect(message).toContain('REDIS_URL is required')
    expect(message).toContain('JWT_SECRET is required')
    expect(message).not.toContain('received undefined')
  })
})

// ─── loadConfig failure path ──────────────────────────────────────────────────

describe('loadConfig failure path', () => {
  function withExitStub() {
    return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__PROCESS_EXIT__:${code}`)
    }) as never)
  }

  it('returns a config without exiting when validation succeeds', () => {
    const exitSpy = withExitStub()

    const config = loadConfig(validEnv())

    expect(config.port).toBe(3000)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('exits with code 1 on invalid configuration', () => {
    const exitSpy = withExitStub()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => loadConfig(validEnv({ PORT: '99999' }))).toThrow('__PROCESS_EXIT__:1')

    // A failed boot must stop the process rather than run with a broken config.
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('logs a diagnosable message naming the bad field', () => {
    withExitStub()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => loadConfig(validEnv({ TIMEOUT_DB_MS: '1' }))).toThrow()

    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('Environment validation failed')
    expect(logged).toContain('TIMEOUT_DB_MS')
  })

  it('points the operator at the environment as the remediation', () => {
    withExitStub()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => loadConfig(validEnv({ PORT: '99999' }))).toThrow()

    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toMatch(/environment variable/i)
  })

  it('rethrows non-validation errors instead of exiting silently', () => {
    withExitStub()

    // An unexpected internal failure must propagate: swallowing it behind
    // process.exit would hide a real bug behind a config-looking message.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile env access')
        },
      },
    ) as Record<string, string | undefined>

    expect(() => loadConfig(hostile)).toThrow('hostile env access')
  })

  it('exits once per failure, not per invalid field', () => {
    const exitSpy = withExitStub()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() =>
      loadConfig(validEnv({ PORT: '99999', TIMEOUT_DB_MS: '1', AUDIT_EXPORT_MAX_WINDOW_DAYS: '0' })),
    ).toThrow()

    expect(exitSpy).toHaveBeenCalledTimes(1)
  })
})

// ─── envSchema direct usage ───────────────────────────────────────────────────

describe('envSchema surface', () => {
  it('accepts a valid env via safeParse', () => {
    expect(envSchema.safeParse(validEnv()).success).toBe(true)
  })

  it('reports failure via safeParse rather than throwing', () => {
    const result = envSchema.safeParse(validEnv({ PORT: '99999' }))

    expect(result.success).toBe(false)
  })

  it('strips unknown keys from the parsed output', () => {
    const result = envSchema.safeParse({
      ...validEnv(),
      UNKNOWN_KEY: 'x',
    } as Record<string, string>)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('UNKNOWN_KEY')
    }
  })

  it('exposes every documented config section after mapping', () => {
    const config = validateConfig(validEnv())

    expect(Object.keys(config).sort()).toEqual(
      [
        'auditLog',
        'cors',
        'credits',
        'db',
        'endpointCostWeights',
        'features',
        'jwt',
        'logLevel',
        'nodeEnv',
        'outboundHttp',
        'outbox',
        'port',
        'rateLimit',
        'redis',
        'reports',
        'reputation',
        'requestSnapshots',
        'shutdown',
        'sorobanCircuitBreaker',
        'timeouts',
        'trustScoreCache',
      ].sort(),
    )
  })
})
