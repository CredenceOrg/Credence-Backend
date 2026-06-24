/**
 * Org-level data-retention configuration.
 *
 * Each entity type can have an independent TTL (time-to-live) expressed in
 * days.  A value of `0` means "keep forever" (no pruning for that type).
 *
 * Settings are consumed by the `DataRetentionJob` and can be overridden via
 * environment variables, making it straightforward to adjust without a code
 * deploy.
 */

export interface EntityRetentionConfig {
  /** Days to keep records after their `created_at` timestamp.  0 = keep forever. */
  ttlDays: number
}

export interface RetentionConfig {
  /**
   * When true the job logs what *would* be deleted without touching the DB.
   * Default: false.
   */
  dryRun: boolean

  /** Maximum rows deleted per entity type per run (prevents runaway deletes). */
  batchLimit: number

  /** Per-entity TTL configuration. */
  entities: {
    scoreHistory: EntityRetentionConfig
    auditLogs: EntityRetentionConfig
    slashEvents: EntityRetentionConfig
    outboxEvents: EntityRetentionConfig
    evidence: EntityRetentionConfig
  }
}

export interface FailedInboundSweeperConfig {
  /**
   * When true the sweeper logs what *would* be deleted without touching the DB.
   * Default: false.
   */
  dryRun: boolean

  /** Maximum rows deleted per run. Default: 5000. */
  batchSize: number

  /**
   * Run interval in milliseconds. Default: 3600000 (1 hour).
   */
  intervalMs: number

  /**
   * Terminal events (replayed/skipped) older than this many days are deleted.
   * Default: 30.
   */
  terminalRetentionDays: number

  /**
   * Failed-status events older than this many days are also deleted.
   * Set to 0 to keep failed events forever. Default: 0.
   */
  failedMaxAgeDays: number
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  dryRun: false,
  batchLimit: 5_000,
  entities: {
    scoreHistory: { ttlDays: 90 },
    auditLogs: { ttlDays: 365 },
    slashEvents: { ttlDays: 0 },
    outboxEvents: { ttlDays: 30 },
    evidence: { ttlDays: 0 },
  },
}

export const DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG: FailedInboundSweeperConfig = {
  dryRun: false,
  batchSize: 5_000,
  intervalMs: 3600000,
  terminalRetentionDays: 30,
  failedMaxAgeDays: 0,
}

function parseTtl(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function loadRetentionConfig(
  env: Record<string, string | undefined> = process.env,
  defaults: RetentionConfig = DEFAULT_RETENTION_CONFIG,
): RetentionConfig {
  return {
    dryRun: (env.RETENTION_DRY_RUN ?? '').toLowerCase() === 'true',
    batchLimit: parseTtl(env.RETENTION_BATCH_LIMIT, defaults.batchLimit),
    entities: {
      scoreHistory: {
        ttlDays: parseTtl(
          env.RETENTION_TTL_SCORE_HISTORY_DAYS,
          defaults.entities.scoreHistory.ttlDays,
        ),
      },
      auditLogs: {
        ttlDays: parseTtl(
          env.RETENTION_TTL_AUDIT_LOGS_DAYS,
          defaults.entities.auditLogs.ttlDays,
        ),
      },
      slashEvents: {
        ttlDays: parseTtl(
          env.RETENTION_TTL_SLASH_EVENTS_DAYS,
          defaults.entities.slashEvents.ttlDays,
        ),
      },
      outboxEvents: {
        ttlDays: parseTtl(
          env.RETENTION_TTL_OUTBOX_EVENTS_DAYS,
          defaults.entities.outboxEvents.ttlDays,
        ),
      },
      evidence: {
        ttlDays: parseTtl(
          env.RETENTION_TTL_EVIDENCE_DAYS,
          defaults.entities.evidence.ttlDays,
        ),
      },
    },
  }
}

export function loadFailedInboundSweeperConfig(
  env: Record<string, string | undefined> = process.env,
  defaults: FailedInboundSweeperConfig = DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG,
): FailedInboundSweeperConfig {
  return {
    dryRun: (env.FAILED_INBOUND_SWEEPER_DRY_RUN ?? '').toLowerCase() === 'true',
    batchSize: parseTtl(env.FAILED_INBOUND_SWEEPER_BATCH_SIZE, defaults.batchSize),
    intervalMs: parseTtl(env.FAILED_INBOUND_SWEEPER_INTERVAL_MS, defaults.intervalMs),
    terminalRetentionDays: parseTtl(
      env.FAILED_INBOUND_SWEEPER_TERMINAL_RETENTION_DAYS,
      defaults.terminalRetentionDays,
    ),
    failedMaxAgeDays: parseTtl(
      env.FAILED_INBOUND_SWEEPER_FAILED_MAX_AGE_DAYS,
      defaults.failedMaxAgeDays,
    ),
  }
}
