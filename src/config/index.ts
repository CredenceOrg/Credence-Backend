import { z } from 'zod'
import dotenv from 'dotenv'
import {
  enforceRetryPolicyCaps,
  type ProviderRetryPolicies,
  type RetryJitterStrategy,
  type RetryPolicy,
  type RetryPolicyOverrides,
} from '../lib/retryPolicy.js'

dotenv.config()

export const envSchema = z.object({
  // Server
  PORT: z
    .string()
    .default('3000')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Database
  DB_URL: z.string().url({ message: 'DB_URL must be a valid URL' }),

  // Redis
  REDIS_URL: z.string().url({ message: 'REDIS_URL must be a valid URL' }),

  // Auth
  JWT_SECRET: z
    .string()
    .min(32, { message: 'JWT_SECRET must be at least 32 characters' }),
  JWT_EXPIRY: z.string().default('1h'),

  // JWT key rotation
  KEY_ROTATION_INTERVAL_SECONDS: z
    .string()
    .default('86400')
    .transform(Number)
    .pipe(z.number().int().positive()),
  KEY_GRACE_PERIOD_SECONDS: z
    .string()
    .default('3600')
    .transform(Number)
    .pipe(z.number().int().nonnegative()),
  /**
   * Clock skew tolerance in seconds.
   * Added to the grace window before a retired key is hard-pruned, and passed
   * as `clockTolerance` to jwtVerify() so tokens from slightly-fast clocks verify.
   * Default: 300 (5 minutes).
   */
  KEY_CLOCK_SKEW_SECONDS: z
    .string()
    .default('300')
    .transform(Number)
    .pipe(z.number().int().nonnegative()),

  // JWT key rotation — private key source
  KEY_PRIVATE_PEM: z.string().optional(),
  KEY_INITIAL_KID: z.string().optional(),

  // Feature flags
  ENABLE_TRUST_SCORING: z
    .string()
    .default('false')
    .transform((val: string) => val === 'true'),
  ENABLE_BOND_EVENTS: z
    .string()
    .default('false')
    .transform((val: string) => val === 'true'),

  // Outbox
  OUTBOX_ENABLED: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),
  OUTBOX_POLL_INTERVAL_MS: z
    .string()
    .default('1000')
    .transform(Number)
    .pipe(z.number().int().min(100)),
  OUTBOX_BATCH_SIZE: z
    .string()
    .default('100')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  OUTBOX_PUBLISHED_RETENTION_DAYS: z
    .string()
    .default('7')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  OUTBOX_FAILED_RETENTION_DAYS: z
    .string()
    .default('30')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  OUTBOX_CLEANUP_INTERVAL_MS: z
    .string()
    .default('3600000')
    .transform(Number)
    .pipe(z.number().int().min(60000)),

  // Horizon (optional)
  HORIZON_URL: z.string().url().optional(),

  // CORS
  CORS_ORIGIN: z.string().default('*'),

  // Outbound retry defaults
  OUTBOUND_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  OUTBOUND_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).default(200),
  OUTBOUND_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(2_000),
  OUTBOUND_RETRY_BACKOFF_MULTIPLIER: z.coerce.number().min(1).default(2),
  OUTBOUND_RETRY_JITTER_STRATEGY: z.enum(['none', 'full', 'equal']).default('none'),

  // Provider-specific outbound retry overrides
  OUTBOUND_RETRY_SOROBAN_MAX_ATTEMPTS: z.coerce.number().int().min(1).optional(),
  OUTBOUND_RETRY_SOROBAN_BASE_DELAY_MS: z.coerce.number().int().min(1).optional(),
  OUTBOUND_RETRY_SOROBAN_MAX_DELAY_MS: z.coerce.number().int().min(1).optional(),
  OUTBOUND_RETRY_SOROBAN_BACKOFF_MULTIPLIER: z.coerce.number().min(1).optional(),
  OUTBOUND_RETRY_SOROBAN_JITTER_STRATEGY: z.enum(['none', 'full', 'equal']).optional(),

  OUTBOUND_RETRY_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).optional(),
  OUTBOUND_RETRY_WEBHOOK_BASE_DELAY_MS: z.coerce.number().int().min(1).optional(),
  OUTBOUND_RETRY_WEBHOOK_MAX_DELAY_MS: z.coerce.number().int().min(1).optional(),
  OUTBOUND_RETRY_WEBHOOK_BACKOFF_MULTIPLIER: z.coerce.number().min(1).optional(),
  OUTBOUND_RETRY_WEBHOOK_JITTER_STRATEGY: z.enum(['none', 'full', 'equal']).optional(),
})

export type Env = z.infer<typeof envSchema>

export interface Config {
  port: number
  nodeEnv: 'development' | 'production' | 'test'
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  db: {
    url: string
  }
  redis: {
    url: string
  }
  jwt: {
    secret: string
    expiry: string
    keyRotationIntervalSeconds: number
    gracePeriodSeconds: number
    /** Clock skew tolerance (seconds) for JWT verification and grace-period pruning. */
    clockSkewSeconds: number
    /**
     * Optional PKCS8 PEM-encoded private key loaded from a secret source.
     * When set, the KeyManager imports this key on startup instead of generating one.
     */
    privateKeyPem?: string
    /** Optional kid assigned to the key loaded from privateKeyPem. */
    initialKid?: string
  }
  features: {
    trustScoring: boolean
    bondEvents: boolean
  }
  outbox: {
    enabled: boolean
    pollIntervalMs: number
    batchSize: number
    publishedRetentionDays: number
    failedRetentionDays: number
    cleanupIntervalMs: number
  }
  horizon?: {
    url: string
  }
  cors: {
    origin: string
  }
  outboundHttp: {
    retry: {
      defaults: RetryPolicy
      providers: Record<string, RetryPolicyOverrides | undefined>
    }
  }
}

function hasRetryOverride(overrides: RetryPolicyOverrides): boolean {
  return Object.values(overrides).some((value) => value !== undefined)
}

function createRetryOverride(params: {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
  jitterStrategy?: RetryJitterStrategy
}): RetryPolicyOverrides | undefined {
  const overrides: RetryPolicyOverrides = {
    maxAttempts: params.maxAttempts,
    baseDelayMs: params.baseDelayMs,
    maxDelayMs: params.maxDelayMs,
    backoffMultiplier: params.backoffMultiplier,
    jitterStrategy: params.jitterStrategy,
  }

  return hasRetryOverride(overrides) ? overrides : undefined
}

function mapEnvToConfig(env: Env): Config {
  const defaultRetryPolicy = enforceRetryPolicyCaps({
    maxAttempts: env.OUTBOUND_RETRY_MAX_ATTEMPTS,
    baseDelayMs: env.OUTBOUND_RETRY_BASE_DELAY_MS,
    maxDelayMs: env.OUTBOUND_RETRY_MAX_DELAY_MS,
    backoffMultiplier: env.OUTBOUND_RETRY_BACKOFF_MULTIPLIER,
    jitterStrategy: env.OUTBOUND_RETRY_JITTER_STRATEGY,
  })

  const providerPolicies: Record<string, RetryPolicyOverrides | undefined> = {}

  const sorobanOverride = createRetryOverride({
    maxAttempts: env.OUTBOUND_RETRY_SOROBAN_MAX_ATTEMPTS,
    baseDelayMs: env.OUTBOUND_RETRY_SOROBAN_BASE_DELAY_MS,
    maxDelayMs: env.OUTBOUND_RETRY_SOROBAN_MAX_DELAY_MS,
    backoffMultiplier: env.OUTBOUND_RETRY_SOROBAN_BACKOFF_MULTIPLIER,
    jitterStrategy: env.OUTBOUND_RETRY_SOROBAN_JITTER_STRATEGY,
  })

  if (sorobanOverride) {
    providerPolicies.soroban = sorobanOverride
  }

  const webhookOverride = createRetryOverride({
    maxAttempts: env.OUTBOUND_RETRY_WEBHOOK_MAX_ATTEMPTS,
    baseDelayMs: env.OUTBOUND_RETRY_WEBHOOK_BASE_DELAY_MS,
    maxDelayMs: env.OUTBOUND_RETRY_WEBHOOK_MAX_DELAY_MS,
    backoffMultiplier: env.OUTBOUND_RETRY_WEBHOOK_BACKOFF_MULTIPLIER,
    jitterStrategy: env.OUTBOUND_RETRY_WEBHOOK_JITTER_STRATEGY,
  })

  if (webhookOverride) {
    providerPolicies.webhook = webhookOverride
  }

  const config: Config = {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    db: {
      url: env.DB_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    jwt: {
      secret: env.JWT_SECRET,
      expiry: env.JWT_EXPIRY,
      keyRotationIntervalSeconds: env.KEY_ROTATION_INTERVAL_SECONDS,
      gracePeriodSeconds: env.KEY_GRACE_PERIOD_SECONDS,
      clockSkewSeconds: env.KEY_CLOCK_SKEW_SECONDS,
      privateKeyPem: env.KEY_PRIVATE_PEM,
      initialKid: env.KEY_INITIAL_KID,
    },
    features: {
      trustScoring: env.ENABLE_TRUST_SCORING,
      bondEvents: env.ENABLE_BOND_EVENTS,
    },
    outbox: {
      enabled: env.OUTBOX_ENABLED,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      publishedRetentionDays: env.OUTBOX_PUBLISHED_RETENTION_DAYS,
      failedRetentionDays: env.OUTBOX_FAILED_RETENTION_DAYS,
      cleanupIntervalMs: env.OUTBOX_CLEANUP_INTERVAL_MS,
    },
    cors: {
      origin: env.CORS_ORIGIN,
    },
    outboundHttp: {
      retry: {
        defaults: defaultRetryPolicy,
        providers: providerPolicies,
      },
    },
  }

  if (env.HORIZON_URL) {
    config.horizon = { url: env.HORIZON_URL }
  }

  return config
}

export class ConfigValidationError extends Error {
  public readonly issues: z.ZodIssue[]

  constructor(issues: z.ZodIssue[]) {
    const formatted = issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')

    super(`Environment validation failed:\n${formatted}`)
    this.name = 'ConfigValidationError'
    this.issues = issues
  }
}

export function validateConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env)

  if (!result.success) {
    throw new ConfigValidationError(result.error.issues)
  }

  return mapEnvToConfig(result.data)
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  try {
    return validateConfig(env)
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(`\n❌ ${err.message}`)
      console.error('\nPlease check your .env file or environment variables.\n')
      process.exit(1)
    }
    throw err
  }
}
