import { z } from 'zod'
import dotenv from 'dotenv'
import { logger } from '../utils/logger.js'
import {
  enforceRetryPolicyCaps,
  type ProviderRetryPolicies,
  type RetryJitterStrategy,
  type RetryPolicy,
  type RetryPolicyOverrides,
} from '../lib/retryPolicy.js'

dotenv.config()

export const envSchema = z.object({
    // Trust score cache TTL (seconds)
    TRUST_SCORE_CACHE_TTL: z
      .string()
      .default('600') // 10 minutes
      .transform(Number)
      .pipe(z.number().int().min(60).max(86400)),
    // Webhook payload size cap in bytes
    WEBHOOK_PAYLOAD_SIZE_CAP: z
      .string()
      .default('262144') // 256 KiB
      .transform(Number)
      .pipe(z.number().int().min(1024).max(10485760)), // 1KB to 10MB
    // Node.js max old space size (MB) - sets --max-old-space-size
    NODE_MAX_OLD_SPACE_SIZE_MB: z
      .string()
      .optional()
      .transform(val => val ? Number(val) : undefined)
      .pipe(z.union([z.undefined(), z.number().int().min(128).max(32768)])), // 128MB to 32GB
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

  // Database pool tuning
  DB_POOL_MAX: z
    .string()
    .default('20')
    .transform(Number)
    .pipe(z.number().int().min(1).max(200)),
  DB_POOL_IDLE_TIMEOUT_MS: z
    .string()
    .default('30000')
    .transform(Number)
    .pipe(z.number().int().min(0)),
  DB_POOL_CONNECTION_TIMEOUT_MS: z
    .string()
    .default('5000')
    .transform(Number)
    .pipe(z.number().int().min(1000).max(30000)),
  DB_STATEMENT_TIMEOUT_MS: z
    .string()
    .default('30000')
    .transform(Number)
    .pipe(z.number().int().min(0)),
  DB_WORKER_POOL_MAX: z
    .string()
    .default('5')
    .transform(Number)
    .pipe(z.number().int().min(1).max(50)),
  DB_LOCK_TIMEOUT_READONLY_MS: z
    .string()
    .default('1000')
    .transform(Number)
    .pipe(z.number().int().min(100).max(30000)),
  DB_LOCK_TIMEOUT_DEFAULT_MS: z
    .string()
    .default('2000')
    .transform(Number)
    .pipe(z.number().int().min(100).max(30000)),
  DB_LOCK_TIMEOUT_CRITICAL_MS: z
    .string()
    .default('10000')
    .transform(Number)
    .pipe(z.number().int().min(100).max(60000)),

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

  // Request snapshots retention
  REQUEST_SNAPSHOT_RETENTION_DAYS: z
    .string()
    .default('14')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  REQUEST_SNAPSHOT_CLEANUP_INTERVAL_MS: z
    .string()
    .default('86400000')
    .transform(Number)
    .pipe(z.number().int().min(60000)),
  REQUEST_SNAPSHOT_CLEANUP_ENABLED: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),

  SHUTDOWN_GRACE_PERIOD_MS: z
    .string()
    .default('30000')
    .transform(Number)
    .pipe(z.number().int().min(1000)),

  // Horizon (optional)
  HORIZON_URL: z.string().url().optional(),

  // CORS
  CORS_ORIGIN: z.string().default('*'),

  // Outbound retry defaults
  OUTBOUND_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  OUTBOUND_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).default(200),
  OUTBOUND_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(2_000),
  OUTBOUND_RETRY_BACKOFF_MULTIPLIER: z.coerce.number().min(1).default(2),
  OUTBOUND_RETRY_JITTER_STRATEGY: z
    .enum(['none', 'full', 'equal'])
    .default('none'),

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

  // Timeout budgets
  TIMEOUT_DB_MS: z
    .string()
    .default('2000')
    .transform(Number)
    .pipe(z.number().int().min(100).max(30000)),
  TIMEOUT_CACHE_MS: z
    .string()
    .default('500')
    .transform(Number)
    .pipe(z.number().int().min(50).max(10000)),
  TIMEOUT_QUEUE_MS: z
    .string()
    .default('1000')
    .transform(Number)
    .pipe(z.number().int().min(100).max(15000)),
  TIMEOUT_HTTP_MS: z
    .string()
    .default('5000')
    .transform(Number)
    .pipe(z.number().int().min(1000).max(60000)),
  TIMEOUT_SOROBAN_MS: z
    .string()
    .default('5000')
    .transform(Number)
    .pipe(z.number().int().min(100).max(45000)),
  TIMEOUT_WEBHOOK_MS: z
    .string()
    .default('10000')
    .transform(Number)
    .pipe(z.number().int().min(2000).max(60000)),

  // Rate limiting
  RATE_LIMIT_ENABLED: z
    .string()
    .default('true')
    .transform((val: string) => val === 'true'),
  RATE_LIMIT_WINDOW_SEC: z
    .string()
    .default('60')
    .transform(Number)
    .pipe(z.number().int().min(1).max(3600)),
  RATE_LIMIT_MAX_FREE: z
    .string()
    .default('100')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  RATE_LIMIT_MAX_PRO: z
    .string()
    .default('1000')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  RATE_LIMIT_MAX_ENTERPRISE: z
    .string()
    .default('10000')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  RATE_LIMIT_FAIL_OPEN: z
    .string()
    .optional()
    .transform((val) => {
      // Explicit env var always wins; default is fail-closed in production
      if (val !== undefined) return val === 'true'
      return process.env.NODE_ENV !== 'production'
    }),

  // Credits / billing
  ENDPOINT_COST_WEIGHTS: z.string().default('{"default":1,"/bulk/verify":10,"/reports":5}'),
  DEFAULT_MONTHLY_CREDITS: z
    .string()
    .default('10000')
    .transform(Number)
    .pipe(z.number().int().min(0)),

  // Reputation scoring model
  REPUTATION_MODEL_VERSION: z.string().default('1.0.0'),
  REPUTATION_BOND_SCORE_MAX: z
    .string()
    .default('50')
    .transform(Number)
    .pipe(z.number().min(0).max(100)),
  REPUTATION_DURATION_SCORE_MAX: z
    .string()
    .default('20')
    .transform(Number)
    .pipe(z.number().min(0).max(100)),
  REPUTATION_ATTESTATION_SCORE_MAX: z
    .string()
    .default('30')
    .transform(Number)
    .pipe(z.number().min(0).max(100)),
  REPUTATION_ONE_ETH_WEI: z
    .string()
    .default('1000000000000000000')
    .refine((val) => {
      try {
        BigInt(val)
        return true
      } catch {
        return false
      }
    }, { message: 'REPUTATION_ONE_ETH_WEI must be a valid BigInt string' }),
  REPUTATION_MAX_DURATION_DAYS: z
    .string()
    .default('365')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  REPUTATION_MAX_ATTESTATION_COUNT: z
    .string()
    .default('5')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD: z
    .string()
    .default('5')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  /**
   * How long (ms) the breaker stays OPEN and rejects all requests immediately
   * after tripping. Default: 10 000 ms (10 s).
   */
  SOROBAN_CIRCUIT_BREAKER_OPEN_WINDOW_MS: z
    .string()
    .default('10000')
    .transform(Number)
    .pipe(z.number().int().min(1000)),
  /**
   * How long (ms) after the breaker trips before a probe is allowed.
   * Must be ≥ SOROBAN_CIRCUIT_BREAKER_OPEN_WINDOW_MS. Default: 30 000 ms (30 s).
   */
  SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS: z
    .string()
    .default('30000')
    .transform(Number)
    .pipe(z.number().int().min(1000)),
  /**
   * @deprecated Use SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS instead.
   * Kept for backwards compatibility; maps to halfOpenAfterMs when the new
   * variable is not set.
   */
  SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : undefined))
    .pipe(z.number().int().min(1000).optional()),
  /**
   * Short-TTL read-through cache for getIdentityState() responses.
   * Set to 0 to disable caching entirely.
   * Default: 5000 ms (5 seconds).
   */
  SOROBAN_STATE_CACHE_TTL_MS: z
    .string()
    .default('5000')
    .transform(Number)
    .pipe(z.number().int().min(0)),

  // Audit log export
  AUDIT_EXPORT_MAX_WINDOW_DAYS: z
    .string()
    .default('90')
    .transform(Number)
    .pipe(z.number().int().min(1).max(3650)),

  // Report generation
  REPORT_MAX_CONCURRENT_JOBS_PER_ORG: z
    .string()
    .default('10')
    .transform(Number)
    .pipe(z.number().int().min(0).max(1000)),

  // Metrics endpoint CIDR whitelist (comma-separated IPv4 CIDRs)
  METRICS_ALLOWED_CIDRS: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

export interface Config {
  trustScoreCache: {
    ttl: number
  }
  port: number
  nodeEnv: 'development' | 'production' | 'test'
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  memory: {
    maxOldSpaceSizeMb?: number
  }
  db: {
    url: string
    lockTimeouts: {
      readonlyMs: number
      defaultMs: number
      criticalMs: number
    }
    pool: {
      max: number
      idleTimeoutMillis: number
      connectionTimeoutMillis: number
      statementTimeoutMs: number
    }
    workerPool: {
      max: number
    }
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
  requestSnapshots: {
    retentionDays: number
    cleanupIntervalMs: number
    cleanupEnabled: boolean
  }
  shutdown: {
    gracePeriodMs: number
  }
  horizon?: {
    url: string
  }
  cors: {
    origin: string
  }
  timeouts: {
    db: number
    cache: number
    queue: number
    http: number
    soroban: number
    webhook: number
  }
  outboundHttp: {
    retry: {
      defaults: RetryPolicy
      providers: Record<string, RetryPolicyOverrides | undefined>
    }
  }
  rateLimit: {
    enabled: boolean
    windowSec: number
    maxFree: number
    maxPro: number
    maxEnterprise: number
    failOpen: boolean
  }
  reputation: {
    scoringModelVersion: string
    bondScoreMax: number
    durationScoreMax: number
    attestationScoreMax: number
    oneEthWei: bigint
    maxDurationDays: number
    maxAttestationCount: number
  }
  sorobanCircuitBreaker: {
    failureThreshold: number
    /**
     * Duration in milliseconds the breaker stays OPEN (fail-fast) after
     * tripping. Default: 10 000 ms (10 s).
     */
    openWindowMs: number
    /**
     * Duration in milliseconds after tripping before a probe is allowed.
     * Default: 30 000 ms (30 s).
     */
    halfOpenAfterMs: number
  }
  sorobanStateCache: {
    /** TTL in milliseconds. 0 = disabled. */
    ttlMs: number
  }
  auditLog: {
    exportMaxWindowDays: number
  }
  reports: {
    maxConcurrentJobsPerOrg: number
  }
  endpointCostWeights: Record<string, number>
  credits: {
    defaultMonthly: number
  }
  metricsAllowedCidrs: string[] | undefined
}

function parseCostWeights(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, number>
    }
    return { default: 1 }
  } catch {
    return { default: 1 }
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
    memory: {
      maxOldSpaceSizeMb: env.NODE_MAX_OLD_SPACE_SIZE_MB
    },
    db: {
      url: env.DB_URL,
      lockTimeouts: {
        readonlyMs: env.DB_LOCK_TIMEOUT_READONLY_MS,
        defaultMs: env.DB_LOCK_TIMEOUT_DEFAULT_MS,
        criticalMs: env.DB_LOCK_TIMEOUT_CRITICAL_MS,
      },
      pool: {
        max: env.DB_POOL_MAX,
        idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
        connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
        statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
      },
      workerPool: {
        max: env.DB_WORKER_POOL_MAX,
      },
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
    requestSnapshots: {
      retentionDays: env.REQUEST_SNAPSHOT_RETENTION_DAYS,
      cleanupIntervalMs: env.REQUEST_SNAPSHOT_CLEANUP_INTERVAL_MS,
      cleanupEnabled: env.REQUEST_SNAPSHOT_CLEANUP_ENABLED,
    },
    shutdown: {
      gracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS,
    },
    cors: {
      origin: env.CORS_ORIGIN,
    },
    timeouts: {
      db: env.TIMEOUT_DB_MS,
      cache: env.TIMEOUT_CACHE_MS,
      queue: env.TIMEOUT_QUEUE_MS,
      http: env.TIMEOUT_HTTP_MS,
      soroban: env.TIMEOUT_SOROBAN_MS,
      webhook: env.TIMEOUT_WEBHOOK_MS,
    },
    outboundHttp: {
      retry: {
        defaults: defaultRetryPolicy,
        providers: providerPolicies,
      },
    },
    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED,
      windowSec: env.RATE_LIMIT_WINDOW_SEC,
      maxFree: env.RATE_LIMIT_MAX_FREE,
      maxPro: env.RATE_LIMIT_MAX_PRO,
      maxEnterprise: env.RATE_LIMIT_MAX_ENTERPRISE,
      failOpen: env.RATE_LIMIT_FAIL_OPEN,
    },
    reputation: {
      scoringModelVersion: env.REPUTATION_MODEL_VERSION,
      bondScoreMax: env.REPUTATION_BOND_SCORE_MAX,
      durationScoreMax: env.REPUTATION_DURATION_SCORE_MAX,
      attestationScoreMax: env.REPUTATION_ATTESTATION_SCORE_MAX,
      oneEthWei: BigInt(env.REPUTATION_ONE_ETH_WEI),
      maxDurationDays: env.REPUTATION_MAX_DURATION_DAYS,
      maxAttestationCount: env.REPUTATION_MAX_ATTESTATION_COUNT,
    },
    trustScoreCache: {
      ttl: env.TRUST_SCORE_CACHE_TTL,
    },
    sorobanCircuitBreaker: {
      failureThreshold: env.SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      openWindowMs: env.SOROBAN_CIRCUIT_BREAKER_OPEN_WINDOW_MS,
      // Prefer the explicit HALF_OPEN_AFTER_MS; fall back to deprecated COOLDOWN_MS.
      halfOpenAfterMs:
        env.SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS ??
        env.SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS ??
        30_000,
    },
    sorobanStateCache: {
      ttlMs: env.SOROBAN_STATE_CACHE_TTL_MS,
    },
    auditLog: {
      exportMaxWindowDays: env.AUDIT_EXPORT_MAX_WINDOW_DAYS,
    },
    reports: {
      maxConcurrentJobsPerOrg: env.REPORT_MAX_CONCURRENT_JOBS_PER_ORG,
    },
    endpointCostWeights: parseCostWeights(env.ENDPOINT_COST_WEIGHTS),
    credits: {
      defaultMonthly: env.DEFAULT_MONTHLY_CREDITS,
    },
    metricsAllowedCidrs: env.METRICS_ALLOWED_CIDRS
      ? env.METRICS_ALLOWED_CIDRS.split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
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
      // Don't exit in test environment
      if (process.env.NODE_ENV !== 'test') {
        logger.error(`\n❌ ${err.message}`)
        logger.error('\nPlease check your .env file or environment variables.\n')
        process.exit(1)
      }
    }
    throw err
  }
}
