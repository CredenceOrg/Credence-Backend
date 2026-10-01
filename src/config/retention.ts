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

import { logger } from '../utils/logger.js';

export interface EntityRetentionConfig {
  /** Days to keep records after their `created_at` timestamp.  0 = keep forever. */
  ttlDays: number
}

export interface OrgRetentionOverrides {
  [orgId: string]: Partial<{
    scoreHistory: EntityRetentionConfig
    auditLogs: EntityRetentionConfig
    slashEvents: EntityRetentionConfig
    outboxEvents: EntityRetentionConfig
    evidence: EntityRetentionConfig
  }>
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

  /** Per-org retention TTL overrides indexed by orgId / tenantId. */
  orgOverrides?: OrgRetentionOverrides
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

/**
 * Deep-freezes a defaults object.
 *
 * Invariant: the exported defaults are process-wide singletons that every
 * loader falls back to. If any caller mutates one, every subsequent load in the
 * process silently inherits the corruption, so they are frozen in dev and prod
 * alike. Loaders return freshly-built objects and never mutate their input.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = deepFreeze({
  dryRun: false,
  batchLimit: 5_000,
  entities: {
    scoreHistory: { ttlDays: 90 },
    auditLogs: { ttlDays: 365 },
    slashEvents: { ttlDays: 0 },
    outboxEvents: { ttlDays: 30 },
    evidence: { ttlDays: 0 },
  },
} satisfies RetentionConfig);

export const DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG: FailedInboundSweeperConfig =
  deepFreeze({
    dryRun: false,
    batchSize: 5_000,
    intervalMs: 3600000,
    terminalRetentionDays: 30,
    failedMaxAgeDays: 0,
  } satisfies FailedInboundSweeperConfig);

/** Env tokens accepted as an explicit "on" for boolean settings. */
const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'on']);

/** Env tokens accepted as an explicit "off" for boolean settings. */
const FALSY_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Parses a boolean env value.
 *
 * Invariant: only recognised tokens decide the flag. Surrounding whitespace is
 * trimmed, so ` true ` is not silently read as false.
 *
 * Unrecognised values fall back to `fallback` and log a warning. This matters
 * most for `dryRun`, whose fallback is false — the destructive path. A typo
 * like `ture` must not quietly run a real deletion pass.
 */
function parseBoolean(
  raw: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (raw === undefined) return fallback;

  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return fallback;
  if (TRUTHY_VALUES.has(normalized)) return true;
  if (FALSY_VALUES.has(normalized)) return false;

  logger.warn(
    `config.retention: ${name} has unrecognised value; falling back to ${fallback}`,
  );
  return fallback;
}

/**
 * Parses a non-negative integer env value with a documented floor.
 *
 * Invariants:
 *
 * - A blank or whitespace-only value falls back to `fallback`; it is never
 *   coerced. `Number('   ')` is `0`, and `0` is not a harmless no-op for these
 *   settings: `batchSize: 0` makes the sweeper's delete loop non-terminating
 *   (`LIMIT 0` removes nothing, so `remaining` never drains and the
 *   `batchDeleted < batchSize` exit test is `0 < 0`), `intervalMs: 0` schedules
 *   the sweeper continuously, and `terminalRetentionDays: 0` moves the cutoff to
 *   now and deletes every terminal event.
 * - `min` is enforced so an explicit out-of-range value cannot recreate those
 *   states. Use `min: 1` for batch sizes and intervals; `0` stays legal only
 *   where it is a documented sentinel ("keep forever" for TTLs).
 * - Fractional values are floored, matching the whole-day/whole-row semantics.
 *
 * Invalid values fall back to `fallback` and log a warning so a typo'd
 * retention setting is diagnosable rather than silently changing how long data
 * is kept.
 */
function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn(
      `config.retention: ${name} is not a finite number; falling back to ${fallback}`,
    );
    return fallback;
  }

  if (parsed < min) {
    logger.warn(
      `config.retention: ${name} must be >= ${min}; falling back to ${fallback}`,
    );
    return fallback;
  }

  return Math.floor(parsed);
}

export function getEffectiveEntityTtl(
  config: RetentionConfig,
  entity: keyof RetentionConfig['entities'],
  orgId?: string,
): number {
  if (orgId && config.orgOverrides?.[orgId]?.[entity]?.ttlDays !== undefined) {
    return config.orgOverrides[orgId]![entity]!.ttlDays
  }
  return config.entities[entity].ttlDays
}

function parseOrgOverrides(raw: string | undefined): OrgRetentionOverrides | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as OrgRetentionOverrides
    }
  } catch {
    // Ignore invalid JSON in env var, fallback to undefined
  }
  return undefined
}

export function loadRetentionConfig(
  env: Record<string, string | undefined> = process.env,
  defaults: RetentionConfig = DEFAULT_RETENTION_CONFIG,
): RetentionConfig {
  return {
    dryRun: parseBoolean(env.RETENTION_DRY_RUN, defaults.dryRun, 'RETENTION_DRY_RUN'),
    batchLimit: parseBoundedInt(
      env.RETENTION_BATCH_LIMIT,
      defaults.batchLimit,
      'RETENTION_BATCH_LIMIT',
      1,
    ),
    entities: {
      // ttlDays === 0 is the documented "keep forever" sentinel: DataRetentionJob
      // skips the entity entirely rather than pruning it.
      scoreHistory: {
        ttlDays: parseBoundedInt(
          env.RETENTION_TTL_SCORE_HISTORY_DAYS,
          defaults.entities.scoreHistory.ttlDays,
          'RETENTION_TTL_SCORE_HISTORY_DAYS',
          0,
        ),
      },
      auditLogs: {
        ttlDays: parseBoundedInt(
          env.RETENTION_TTL_AUDIT_LOGS_DAYS,
          defaults.entities.auditLogs.ttlDays,
          'RETENTION_TTL_AUDIT_LOGS_DAYS',
          0,
        ),
      },
      slashEvents: {
        ttlDays: parseBoundedInt(
          env.RETENTION_TTL_SLASH_EVENTS_DAYS,
          defaults.entities.slashEvents.ttlDays,
          'RETENTION_TTL_SLASH_EVENTS_DAYS',
          0,
        ),
      },
      outboxEvents: {
        ttlDays: parseBoundedInt(
          env.RETENTION_TTL_OUTBOX_EVENTS_DAYS,
          defaults.entities.outboxEvents.ttlDays,
          'RETENTION_TTL_OUTBOX_EVENTS_DAYS',
          0,
        ),
      },
      evidence: {
        ttlDays: parseBoundedInt(
          env.RETENTION_TTL_EVIDENCE_DAYS,
          defaults.entities.evidence.ttlDays,
          'RETENTION_TTL_EVIDENCE_DAYS',
          0,
        ),
      },
    },
    orgOverrides: parseOrgOverrides(env.RETENTION_ORG_OVERRIDES) ?? defaults.orgOverrides,
  }
}

export function loadFailedInboundSweeperConfig(
  env: Record<string, string | undefined> = process.env,
  defaults: FailedInboundSweeperConfig = DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG,
): FailedInboundSweeperConfig {
  return {
    dryRun: parseBoolean(
      env.FAILED_INBOUND_SWEEPER_DRY_RUN,
      defaults.dryRun,
      'FAILED_INBOUND_SWEEPER_DRY_RUN',
    ),
    // batchSize and intervalMs require >= 1: 0 makes the delete loop
    // non-terminating and the scheduler fire continuously, respectively.
    batchSize: parseBoundedInt(
      env.FAILED_INBOUND_SWEEPER_BATCH_SIZE,
      defaults.batchSize,
      'FAILED_INBOUND_SWEEPER_BATCH_SIZE',
      1,
    ),
    intervalMs: parseBoundedInt(
      env.FAILED_INBOUND_SWEEPER_INTERVAL_MS,
      defaults.intervalMs,
      'FAILED_INBOUND_SWEEPER_INTERVAL_MS',
      1,
    ),
    // Note the asymmetry with RetentionConfig.ttlDays: here 0 means "delete
    // every terminal event", not "keep forever". The cutoff lands on now.
    terminalRetentionDays: parseBoundedInt(
      env.FAILED_INBOUND_SWEEPER_TERMINAL_RETENTION_DAYS,
      defaults.terminalRetentionDays,
      'FAILED_INBOUND_SWEEPER_TERMINAL_RETENTION_DAYS',
      0,
    ),
    failedMaxAgeDays: parseBoundedInt(
      env.FAILED_INBOUND_SWEEPER_FAILED_MAX_AGE_DAYS,
      defaults.failedMaxAgeDays,
      'FAILED_INBOUND_SWEEPER_FAILED_MAX_AGE_DAYS',
      0,
    ),
  }
}
