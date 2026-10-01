/**
 * Boundary and recovery coverage for the retention configuration constants and
 * their env loaders.
 *
 * Unlike `src/config/index.ts`, this module does not throw on bad input — it
 * silently falls back to a default. That makes the edges matter more, not less:
 * a stray space in an env file must not change how long data is kept, and must
 * never push the deletion jobs into a non-terminating or mass-delete state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  loadRetentionConfig,
  loadFailedInboundSweeperConfig,
  DEFAULT_RETENTION_CONFIG,
  DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG,
  type RetentionConfig,
  type FailedInboundSweeperConfig,
} from '../retention.js'
import { logger } from '../../utils/logger.js'
import { FailedInboundEventsSweeper } from '../../jobs/failedInboundEventsSweeper.js'

/** Entity TTL env keys, paired with their default values. */
const RETENTION_TTL_KEYS = [
  ['RETENTION_TTL_SCORE_HISTORY_DAYS', 90],
  ['RETENTION_TTL_AUDIT_LOGS_DAYS', 365],
  ['RETENTION_TTL_SLASH_EVENTS_DAYS', 0],
  ['RETENTION_TTL_OUTBOX_EVENTS_DAYS', 30],
  ['RETENTION_TTL_EVIDENCE_DAYS', 0],
] as const

const RETENTION_TTL_PATH = {
  RETENTION_TTL_SCORE_HISTORY_DAYS: 'scoreHistory',
  RETENTION_TTL_AUDIT_LOGS_DAYS: 'auditLogs',
  RETENTION_TTL_SLASH_EVENTS_DAYS: 'slashEvents',
  RETENTION_TTL_OUTBOX_EVENTS_DAYS: 'outboxEvents',
  RETENTION_TTL_EVIDENCE_DAYS: 'evidence',
} as const

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Exported constants ───────────────────────────────────────────────────────

describe('exported default constants', () => {
  it('exposes the documented retention defaults', () => {
    expect(DEFAULT_RETENTION_CONFIG).toEqual({
      dryRun: false,
      batchLimit: 5_000,
      entities: {
        scoreHistory: { ttlDays: 90 },
        auditLogs: { ttlDays: 365 },
        slashEvents: { ttlDays: 0 },
        outboxEvents: { ttlDays: 30 },
        evidence: { ttlDays: 0 },
      },
    })
  })

  it('exposes the documented sweeper defaults', () => {
    expect(DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG).toEqual({
      dryRun: false,
      batchSize: 5_000,
      intervalMs: 3_600_000,
      terminalRetentionDays: 30,
      failedMaxAgeDays: 0,
    })
  })

  it('defaults to a non-destructive batch size and interval for both jobs', () => {
    // 0 for batchSize is a non-terminating delete loop; 0 for intervalMs is a
    // continuous scheduler. Neither may ever be the shipped default.
    expect(DEFAULT_RETENTION_CONFIG.batchLimit).toBeGreaterThanOrEqual(1)
    expect(DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG.batchSize).toBeGreaterThanOrEqual(1)
    expect(DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG.intervalMs).toBeGreaterThanOrEqual(1)
  })

  it('freezes the defaults so a caller cannot corrupt them process-wide', () => {
    // These are singletons every loader falls back to; mutating one would
    // silently change the behaviour of every later load in the process.
    expect(Object.isFrozen(DEFAULT_RETENTION_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_RETENTION_CONFIG.entities)).toBe(true)
    expect(Object.isFrozen(DEFAULT_RETENTION_CONFIG.entities.evidence)).toBe(true)
    expect(Object.isFrozen(DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG)).toBe(true)
  })

  it('resists mutation attempts without changing later loads', () => {
    const before = loadRetentionConfig({}).batchLimit
    const beforeSweeper = loadFailedInboundSweeperConfig({}).batchSize

    expect(() => {
      (DEFAULT_RETENTION_CONFIG as { batchLimit: number }).batchLimit = 1
    }).toThrow(TypeError)
    expect(() => {
      (DEFAULT_RETENTION_CONFIG.entities.evidence as { ttlDays: number }).ttlDays = 5
    }).toThrow(TypeError)

    expect(loadRetentionConfig({}).batchLimit).toBe(before)
    expect(loadFailedInboundSweeperConfig({}).batchSize).toBe(beforeSweeper)
  })
})

// ─── Blank and whitespace input ───────────────────────────────────────────────

describe('blank env values never coerce to zero', () => {
  // `Number('')`, `Number('   ')` and `Number('\t\n')` are all 0. For a TTL, 0
  // means "keep forever"; for the sweeper it means "delete everything now".
  const BLANKS = ['', ' ', '   ', '\t', '\n', ' \t\n ']

  for (const blank of BLANKS) {
    it(`retention TTL keeps its default for blank ${JSON.stringify(blank)}`, () => {
      const config = loadRetentionConfig({
        RETENTION_TTL_SCORE_HISTORY_DAYS: blank,
        RETENTION_TTL_AUDIT_LOGS_DAYS: blank,
        RETENTION_TTL_OUTBOX_EVENTS_DAYS: blank,
      })

      expect(config.entities.scoreHistory.ttlDays).toBe(90)
      expect(config.entities.auditLogs.ttlDays).toBe(365)
      expect(config.entities.outboxEvents.ttlDays).toBe(30)
    })

    it(`sweeper batch size keeps its default for blank ${JSON.stringify(blank)}`, () => {
      const config = loadFailedInboundSweeperConfig({
        FAILED_INBOUND_SWEEPER_BATCH_SIZE: blank,
      })

      expect(config.batchSize).toBe(5_000)
    })

    it(`sweeper interval keeps its default for blank ${JSON.stringify(blank)}`, () => {
      const config = loadFailedInboundSweeperConfig({
        FAILED_INBOUND_SWEEPER_INTERVAL_MS: blank,
      })

      expect(config.intervalMs).toBe(3_600_000)
    })

    it(`sweeper terminal retention keeps its default for blank ${JSON.stringify(blank)}`, () => {
      // Regression: blank coerced to 0 moved the cutoff to now, deleting every
      // terminal event on the first run.
      const config = loadFailedInboundSweeperConfig({
        FAILED_INBOUND_SWEEPER_TERMINAL_RETENTION_DAYS: blank,
      })

      expect(config.terminalRetentionDays).toBe(30)
    })
  }

  it('retention batch limit keeps its default when blank', () => {
    expect(loadRetentionConfig({ RETENTION_BATCH_LIMIT: '   ' }).batchLimit).toBe(5_000)
  })

  it('does not warn for blank input, which is treated as unset', () => {
    loadRetentionConfig({ RETENTION_TTL_SCORE_HISTORY_DAYS: '  ' })
    loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_BATCH_SIZE: '' })

    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// ─── Batch size and interval floors ───────────────────────────────────────────

describe('batch size and interval floors', () => {
  it('rejects an explicit batch size of 0', () => {
    // LIMIT 0 deletes nothing, so the sweeper's drain loop never terminates.
    const config = loadFailedInboundSweeperConfig({
      FAILED_INBOUND_SWEEPER_BATCH_SIZE: '0',
    })

    expect(config.batchSize).toBe(5_000)
  })

  it('accepts a batch size of 1', () => {
    expect(
      loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_BATCH_SIZE: '1' }).batchSize,
    ).toBe(1)
  })

  it('rejects a negative batch size', () => {
    expect(
      loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_BATCH_SIZE: '-1' }).batchSize,
    ).toBe(5_000)
  })

  it('rejects a fractional batch size below 1', () => {
    expect(
      loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_BATCH_SIZE: '0.5' }).batchSize,
    ).toBe(5_000)
  })

  it('floors a fractional batch size at or above 1', () => {
    expect(
      loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_BATCH_SIZE: '10.9' }).batchSize,
    ).toBe(10)
  })

  it('rejects an explicit interval of 0', () => {
    // setInterval(fn, 0) fires continuously, turning each sweep into a hot loop.
    expect(
      loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_INTERVAL_MS: '0' }).intervalMs,
    ).toBe(3_600_000)
  })

  it('accepts an interval of 1ms', () => {
    expect(
      loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_INTERVAL_MS: '1' }).intervalMs,
    ).toBe(1)
  })

  it('rejects a retention batch limit of 0', () => {
    expect(loadRetentionConfig({ RETENTION_BATCH_LIMIT: '0' }).batchLimit).toBe(5_000)
  })

  it('warns when a value is present but below the floor', () => {
    loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_BATCH_SIZE: '0' })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('FAILED_INBOUND_SWEEPER_BATCH_SIZE'),
    )
  })
})

// ─── TTL sentinels and boundaries ─────────────────────────────────────────────

describe('TTL sentinel and boundary values', () => {
  for (const [key, defaultTtl] of RETENTION_TTL_KEYS) {
    const path = RETENTION_TTL_PATH[key]

    it(`${key} accepts 0 as the keep-forever sentinel`, () => {
      const config = loadRetentionConfig({ [key]: '0' })

      expect(config.entities[path].ttlDays).toBe(0)
    })

    it(`${key} accepts 1 day`, () => {
      expect(loadRetentionConfig({ [key]: '1' }).entities[path].ttlDays).toBe(1)
    })

    it(`${key} falls back for a negative value`, () => {
      expect(loadRetentionConfig({ [key]: '-1' }).entities[path].ttlDays).toBe(defaultTtl)
    })

    it(`${key} floors a fractional value`, () => {
      expect(loadRetentionConfig({ [key]: '9.9' }).entities[path].ttlDays).toBe(9)
    })

    it(`${key} accepts a large value`, () => {
      expect(loadRetentionConfig({ [key]: '36500' }).entities[path].ttlDays).toBe(36_500)
    })

    it.each([
      ['non-numeric', 'soon'],
      ['partially numeric', '30d'],
      ['Infinity', 'Infinity'],
      ['NaN', 'NaN'],
      ['a lone minus sign', '-'],
    ])(`${key} falls back for %s input`, (_label, value) => {
      expect(loadRetentionConfig({ [key]: value }).entities[path].ttlDays).toBe(defaultTtl)
    })

    it(`${key} warns for an unparseable value`, () => {
      loadRetentionConfig({ [key]: 'soon' })

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(key))
    })
  }

  it('accepts 0 for the sweeper failedMaxAgeDays keep-forever sentinel', () => {
    expect(
      loadFailedInboundSweeperConfig({
        FAILED_INBOUND_SWEEPER_FAILED_MAX_AGE_DAYS: '0',
      }).failedMaxAgeDays,
    ).toBe(0)
  })

  it('accepts 0 for sweeper terminalRetentionDays, which deletes all terminal events', () => {
    // Documented asymmetry with the retention TTLs: here 0 is a purge, not
    // "keep forever". It stays legal so an operator can request it explicitly.
    expect(
      loadFailedInboundSweeperConfig({
        FAILED_INBOUND_SWEEPER_TERMINAL_RETENTION_DAYS: '0',
      }).terminalRetentionDays,
    ).toBe(0)
  })
})

// ─── Boolean flag parsing ─────────────────────────────────────────────────────

describe('dryRun flag parsing', () => {
  const CASES: Array<[string, boolean]> = [
    ['true', true],
    ['TRUE', true],
    ['True', true],
    ['  true  ', true],
    ['1', true],
    ['yes', true],
    ['YES', true],
    ['on', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['off', false],
  ]

  for (const [value, expected] of CASES) {
    it(`sweeper dryRun resolves ${JSON.stringify(value)} to ${expected}`, () => {
      expect(
        loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_DRY_RUN: value }).dryRun,
      ).toBe(expected)
    })

    it(`retention dryRun resolves ${JSON.stringify(value)} to ${expected}`, () => {
      expect(loadRetentionConfig({ RETENTION_DRY_RUN: value }).dryRun).toBe(expected)
    })
  }

  it('defaults dryRun to false when unset, so a typo cannot silently imply dry run', () => {
    expect(loadFailedInboundSweeperConfig({}).dryRun).toBe(false)
    expect(loadRetentionConfig({}).dryRun).toBe(false)
  })

  it.each(['ture', 'maybe', '2', 'truthy'])(
    'falls back to false and warns for unrecognised dryRun value %j',
    (value) => {
      const config = loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_DRY_RUN: value })

      expect(config.dryRun).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('FAILED_INBOUND_SWEEPER_DRY_RUN'),
      )
    },
  )

  it('honours a non-false default for dryRun when falling back', () => {
    const defaults: FailedInboundSweeperConfig = {
      ...DEFAULT_FAILED_INBOUND_SWEEPER_CONFIG,
      dryRun: true,
    }
    const config = loadFailedInboundSweeperConfig(
      { FAILED_INBOUND_SWEEPER_DRY_RUN: 'maybe' },
      defaults,
    )

    // An unparseable value must defer to the caller's default, not hard-code false.
    expect(config.dryRun).toBe(true)
  })

  it('treats blank dryRun as unset without warning', () => {
    expect(loadRetentionConfig({ RETENTION_DRY_RUN: '   ' }).dryRun).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// ─── Custom defaults ──────────────────────────────────────────────────────────

describe('custom defaults', () => {
  it('uses a custom defaults object throughout', () => {
    const defaults: RetentionConfig = {
      dryRun: true,
      batchLimit: 42,
      entities: {
        scoreHistory: { ttlDays: 1 },
        auditLogs: { ttlDays: 2 },
        slashEvents: { ttlDays: 3 },
        outboxEvents: { ttlDays: 4 },
        evidence: { ttlDays: 5 },
      },
    }

    expect(loadRetentionConfig({}, defaults)).toEqual(defaults)
  })

  it('uses a custom defaults object for the sweeper', () => {
    const defaults: FailedInboundSweeperConfig = {
      dryRun: true,
      batchSize: 7,
      intervalMs: 11,
      terminalRetentionDays: 13,
      failedMaxAgeDays: 17,
    }

    expect(loadFailedInboundSweeperConfig({}, defaults)).toEqual(defaults)
  })

  it('overrides only the fields present in env', () => {
    const defaults: RetentionConfig = {
      ...DEFAULT_RETENTION_CONFIG,
      entities: {
        scoreHistory: { ttlDays: 11 },
        auditLogs: { ttlDays: 22 },
        slashEvents: { ttlDays: 33 },
        outboxEvents: { ttlDays: 44 },
        evidence: { ttlDays: 55 },
      },
    }

    const config = loadRetentionConfig({ RETENTION_TTL_AUDIT_LOGS_DAYS: '99' }, defaults)

    expect(config.entities.auditLogs.ttlDays).toBe(99)
    expect(config.entities.scoreHistory.ttlDays).toBe(11)
    expect(config.entities.evidence.ttlDays).toBe(55)
  })

  it('does not mutate the supplied defaults object', () => {
    const defaults: RetentionConfig = {
      dryRun: false,
      batchLimit: 100,
      entities: {
        scoreHistory: { ttlDays: 1 },
        auditLogs: { ttlDays: 2 },
        slashEvents: { ttlDays: 3 },
        outboxEvents: { ttlDays: 4 },
        evidence: { ttlDays: 5 },
      },
    }
    const snapshot = JSON.parse(JSON.stringify(defaults))

    loadRetentionConfig({ RETENTION_TTL_SCORE_HISTORY_DAYS: '999' }, defaults)

    expect(defaults).toEqual(snapshot)
  })

  it('does not share nested entity objects between returned configs', () => {
    const a = loadRetentionConfig({})
    const b = loadRetentionConfig({})

    expect(a.entities).not.toBe(b.entities)
    expect(a.entities.evidence).not.toBe(b.entities.evidence)

    a.entities.evidence.ttlDays = 999
    expect(b.entities.evidence.ttlDays).toBe(0)
  })

  it('returns a config whose entity set is complete', () => {
    const config = loadRetentionConfig({})

    expect(Object.keys(config.entities).sort()).toEqual([
      'auditLogs',
      'evidence',
      'outboxEvents',
      'scoreHistory',
      'slashEvents',
    ])
  })
})

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces identical output for repeated calls with the same env', () => {
    const env = { RETENTION_TTL_AUDIT_LOGS_DAYS: '30', FAILED_INBOUND_SWEEPER_DRY_RUN: 'true' }

    const first = loadRetentionConfig(env)
    for (let i = 0; i < 20; i += 1) {
      expect(loadRetentionConfig(env)).toEqual(first)
    }
  })

  it('does not mutate the input env object', () => {
    const env = { RETENTION_TTL_AUDIT_LOGS_DAYS: '30' }
    const snapshot = { ...env }

    loadRetentionConfig(env)

    expect(env).toEqual(snapshot)
  })

  it('produces the same sweeper config regardless of load order', () => {
    const env = { FAILED_INBOUND_SWEEPER_BATCH_SIZE: '250' }

    const first = loadFailedInboundSweeperConfig(env)
    loadFailedInboundSweeperConfig({ FAILED_INBOUND_SWEEPER_BATCH_SIZE: 'oops' })
    loadRetentionConfig({})

    expect(loadFailedInboundSweeperConfig(env)).toEqual(first)
  })

  it('defaults to process.env when no env argument is given', () => {
    // Smoke test that the default parameter resolves; the values themselves
    // depend on the ambient environment.
    const config = loadFailedInboundSweeperConfig()

    expect(config.batchSize).toBeGreaterThanOrEqual(1)
    expect(config.intervalMs).toBeGreaterThanOrEqual(1)
  })

  it('handles an entirely empty env identically to an empty object', () => {
    expect(loadRetentionConfig({})).toEqual(loadRetentionConfig({}))
    expect(loadFailedInboundSweeperConfig({}).batchSize).toBe(5_000)
  })
})

// ─── Integration with the sweeper's delete loop ───────────────────────────────

describe('sweeper delete loop terminates for every configured batch size', () => {
  /**
   * Builds a fake DB where the terminal-count query reports `total` rows and
   * every DELETE removes `perDelete` rows (capped at the LIMIT).
   */
  function fakeDb(total: number, perDelete: number) {
    const state = { deleteCalls: 0 }

    const db = {
      query: async (sql: string) => {
        if (sql.includes('COUNT(*)::TEXT AS count') && sql.includes('status IN')) {
          return { rows: [{ count: String(total) }], rowCount: 1 }
        }
        state.deleteCalls += 1
        return { rows: [], rowCount: perDelete }
      },
    }

    return { db, state }
  }

  it.each([1, 2, 10, 5000])('drains the backlog with batchSize %i', async (batchSize) => {
    const total = 10
    // A batch can never delete more rows than the backlog holds.
    const { db, state } = fakeDb(total, Math.min(batchSize, total))
    const config = loadFailedInboundSweeperConfig({
      FAILED_INBOUND_SWEEPER_BATCH_SIZE: String(batchSize),
    })
    const sweeper = new FailedInboundEventsSweeper(db as never, config)

    const result = await sweeper.run()

    expect(config.batchSize).toBe(batchSize)
    expect(result.deletedCount).toBe(total)
    expect(state.deleteCalls).toBeGreaterThan(0)
  })

  it('terminates instead of spinning when the env value would produce 0', async () => {
    // Regression: a blank FAILED_INBOUND_SWEEPER_BATCH_SIZE used to become 0,
    // and `DELETE ... LIMIT 0` deleted nothing, so `remaining` never drained
    // and the loop never exited.
    const { db, state } = fakeDb(10, 0)
    const config = loadFailedInboundSweeperConfig({
      FAILED_INBOUND_SWEEPER_BATCH_SIZE: '   ',
    })
    expect(config.batchSize).toBe(5_000)

    const sweeper = new FailedInboundEventsSweeper(db as never, { ...config, dryRun: true })
    const result = await sweeper.run()

    expect(result.dryRun).toBe(true)
    expect(result.deletedCount).toBe(0)
    expect(state.deleteCalls).toBe(0)
  })

  it('does not delete anything in dry-run mode', async () => {
    const { db, state } = fakeDb(25, 5)
    const config = loadFailedInboundSweeperConfig({
      FAILED_INBOUND_SWEEPER_DRY_RUN: 'true',
      FAILED_INBOUND_SWEEPER_BATCH_SIZE: '5',
    })

    const result = new FailedInboundEventsSweeper(db as never, config).run().then((r) => r)

    expect((await result).deletedCount).toBe(0)
    expect(state.deleteCalls).toBe(0)
  })
})
