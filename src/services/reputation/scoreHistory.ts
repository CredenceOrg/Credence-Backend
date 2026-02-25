import type { ReputationScore } from './types.js'
import type {
  IdentityState,
  IdentityStateSyncHooks,
  IdentityStateUpdatedEvent,
} from '../../listeners/types.js'

/**
 * Supported event types for snapshot creation.
 */
export type ScoreSourceEvent = 'bond' | 'attestation' | 'slash'

/**
 * Persisted reputation score snapshot model.
 */
export interface ScoreSnapshot {
  identityAddress: string
  windowStart: Date
  windowEnd: Date
  score: number
  bondScore: number
  attestationScore: number
  timeWeight: number
  sourceEvent: ScoreSourceEvent
  capturedAt: Date
}

/**
 * Result returned after attempting to persist one snapshot.
 */
export interface SnapshotWriteResult {
  created: boolean
}

/**
 * Persistence abstraction for score history writes.
 */
export interface ScoreHistoryRepository {
  upsertSnapshot(snapshot: ScoreSnapshot): Promise<SnapshotWriteResult>
}

/**
 * Service configuration for score history snapshots.
 */
export interface ScoreHistoryServiceOptions {
  windowMs: number
}

/**
 * Input payload for event-driven snapshot persistence.
 */
export interface RecordFromEventInput {
  identityAddress: string
  sourceEvent: ScoreSourceEvent
  score: ReputationScore
  occurredAt?: Date
}

/**
 * Output payload for event-driven snapshot persistence.
 */
export interface RecordFromEventResult {
  created: boolean
  snapshot: ScoreSnapshot
}

/**
 * Computes a reputation score for an identity when an update event occurs.
 */
export interface ScoreProvider {
  getScoreForIdentity(address: string, state: IdentityState): Promise<ReputationScore>
}

interface QueryResultLike {
  rowCount?: number | null
}

interface QueryableClient {
  query(text: string, values?: unknown[]): Promise<QueryResultLike>
}

/**
 * Postgres-backed score history repository.
 */
export class PgScoreHistoryRepository implements ScoreHistoryRepository {
  private pool: QueryableClient | null = null

  constructor(
    private readonly options: {
      connectionString?: string
      client?: QueryableClient
    } = {}
  ) {
    this.pool = options.client ?? null
  }

  /**
   * Persists a snapshot with idempotency on (identity_address, window_start, source_event).
   */
  async upsertSnapshot(snapshot: ScoreSnapshot): Promise<SnapshotWriteResult> {
    const client = await this.getClient()
    const result = await client.query(
      `
      INSERT INTO score_history (
        identity_address,
        window_start,
        window_end,
        score,
        bond_score,
        attestation_score,
        time_weight,
        source_event,
        captured_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (identity_address, window_start, source_event) DO NOTHING
      RETURNING identity_address
      `,
      [
        snapshot.identityAddress,
        snapshot.windowStart,
        snapshot.windowEnd,
        snapshot.score,
        snapshot.bondScore,
        snapshot.attestationScore,
        snapshot.timeWeight,
        snapshot.sourceEvent,
        snapshot.capturedAt,
      ]
    )

    return { created: (result.rowCount ?? 0) > 0 }
  }

  private async getClient(): Promise<QueryableClient> {
    if (this.pool) {
      return this.pool
    }

    const connectionString = this.options.connectionString ?? process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for PgScoreHistoryRepository')
    }

    const pg = (await import('pg')).default
    this.pool = new pg.Pool({ connectionString })
    return this.pool
  }
}

/**
 * Service for event-driven reputation score history persistence.
 */
export class ScoreHistoryService {
  private readonly windowMs: number

  constructor(
    private readonly repository: ScoreHistoryRepository,
    options: ScoreHistoryServiceOptions
  ) {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error('windowMs must be a positive number')
    }
    this.windowMs = Math.floor(options.windowMs)
  }

  /**
   * Creates a snapshot for an event, buckets it by logical time window, and persists it.
   */
  async recordFromEvent(input: RecordFromEventInput): Promise<RecordFromEventResult> {
    if (!/^G[A-Z2-7]{55}$/.test(input.identityAddress)) {
      throw new Error('invalid Stellar identity address')
    }

    const occurredAt = input.occurredAt ?? new Date()
    const { windowStart, windowEnd } = this.getWindowBounds(occurredAt)

    const snapshot: ScoreSnapshot = {
      identityAddress: input.identityAddress,
      windowStart,
      windowEnd,
      score: input.score.totalScore,
      bondScore: input.score.bondScore,
      attestationScore: input.score.attestationScore,
      timeWeight: input.score.timeWeight,
      sourceEvent: input.sourceEvent,
      capturedAt: new Date(),
    }

    const { created } = await this.repository.upsertSnapshot(snapshot)
    return { created, snapshot }
  }

  private getWindowBounds(at: Date): { windowStart: Date; windowEnd: Date } {
    const timeMs = at.getTime()
    const startMs = Math.floor(timeMs / this.windowMs) * this.windowMs
    return {
      windowStart: new Date(startMs),
      windowEnd: new Date(startMs + this.windowMs),
    }
  }
}

/**
 * Creates listener hooks that persist score-history snapshots on state updates.
 */
export function createScoreHistorySyncHooks(
  historyService: ScoreHistoryService,
  scoreProvider: ScoreProvider
): IdentityStateSyncHooks {
  return {
    onStateUpdated: async (event: IdentityStateUpdatedEvent): Promise<void> => {
      const score = await scoreProvider.getScoreForIdentity(event.address, event.chainState)
      await historyService.recordFromEvent({
        identityAddress: event.address,
        sourceEvent: event.eventType,
        score,
        occurredAt: event.updatedAt,
      })
    },
  }
}
