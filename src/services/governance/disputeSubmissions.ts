import { randomUUID } from 'node:crypto'

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/
const DISPUTABLE_STATUSES = new Set(['pending', 'open', 'requested'])

/**
 * Request payload for dispute submissions against slash requests.
 */
export interface DisputeSubmissionInput {
  slashRequestId: string
  identity: string
  evidence: string[]
  stake?: string
}

/**
 * Persisted dispute submission model.
 */
export interface PersistedDisputeSubmission {
  id: string
  slashRequestId: string
  identity: string
  evidence: string[]
  stake: string | null
  status: string
  submittedAt: Date
}

/**
 * Slash request state required for dispute validation.
 */
export interface SlashRequestRecord {
  id: string
  identity: string
  status: string
  disputableUntil: Date
}

/**
 * Event payload emitted when dispute is successfully submitted.
 */
export interface DisputeSubmittedEvent {
  type: 'governance.dispute_submitted'
  dispute_id: string
  slash_request_id: string
  identity: string
  submitted_at: string
  stake: string | null
  evidence_count: number
}

/**
 * Internal event publisher contract for arbitration consumers.
 */
export interface ArbitrationEventPublisher {
  publishDisputeSubmitted(event: DisputeSubmittedEvent): Promise<void>
}

/**
 * Transaction-scoped repository methods for dispute submissions.
 */
export interface DisputeSubmissionRepositoryTx {
  getSlashRequestForUpdate(id: string): Promise<SlashRequestRecord | null>
  insertDispute(input: {
    id: string
    slashRequestId: string
    identity: string
    evidence: string[]
    stake: string | null
    submittedAt: Date
  }): Promise<PersistedDisputeSubmission | null>
  markSlashRequestDisputed?(id: string): Promise<void>
}

/**
 * Dispute submission repository with transaction support.
 */
export interface DisputeSubmissionRepository {
  withTransaction<T>(fn: (tx: DisputeSubmissionRepositoryTx) => Promise<T>): Promise<T>
}

/**
 * Domain error emitted by dispute submission service.
 */
export class DisputeSubmissionError extends Error {
  constructor(
    public readonly code:
      | 'VALIDATION_ERROR'
      | 'SLASH_REQUEST_NOT_FOUND'
      | 'NOT_DISPUTABLE'
      | 'DEADLINE_PASSED'
      | 'ALREADY_DISPUTED'
      | 'IDENTITY_MISMATCH'
      | 'EVENT_PUBLISH_FAILED',
    message: string
  ) {
    super(message)
    this.name = 'DisputeSubmissionError'
  }
}

interface QueryResultLike<T = unknown> {
  rows: T[]
}

interface PgClientLike {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>
  release?: () => void
}

interface PgPoolLike {
  connect(): Promise<PgClientLike>
}

/**
 * Postgres-backed repository for dispute submissions.
 */
export class PgDisputeSubmissionRepository implements DisputeSubmissionRepository {
  private pool: PgPoolLike | null = null

  constructor(
    private readonly options: {
      connectionString?: string
      pool?: PgPoolLike
    } = {}
  ) {
    this.pool = options.pool ?? null
  }

  async withTransaction<T>(fn: (tx: DisputeSubmissionRepositoryTx) => Promise<T>): Promise<T> {
    const pool = await this.getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tx = new PgDisputeSubmissionRepositoryTx(client)
      const result = await fn(tx)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release?.()
    }
  }

  private async getPool(): Promise<PgPoolLike> {
    if (this.pool) {
      return this.pool
    }
    const connectionString = this.options.connectionString ?? process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for dispute submissions')
    }
    const pg = (await import('pg')).default
    this.pool = new pg.Pool({ connectionString })
    return this.pool
  }
}

class PgDisputeSubmissionRepositoryTx implements DisputeSubmissionRepositoryTx {
  constructor(private readonly client: PgClientLike) {}

  async getSlashRequestForUpdate(id: string): Promise<SlashRequestRecord | null> {
    const result = await this.client.query<{
      id: string
      identity: string
      status: string
      disputable_until: string | Date
    }>(
      `
      SELECT id, identity, status, disputable_until
      FROM slash_requests
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    )

    const row = result.rows[0]
    if (!row) {
      return null
    }
    return {
      id: row.id,
      identity: row.identity,
      status: row.status,
      disputableUntil: new Date(row.disputable_until),
    }
  }

  async insertDispute(input: {
    id: string
    slashRequestId: string
    identity: string
    evidence: string[]
    stake: string | null
    submittedAt: Date
  }): Promise<PersistedDisputeSubmission | null> {
    const result = await this.client.query<{
      id: string
      slash_request_id: string
      identity: string
      evidence: string[]
      stake: string | null
      status: string
      submitted_at: string | Date
    }>(
      `
      INSERT INTO disputes (
        id,
        slash_request_id,
        identity,
        evidence,
        stake,
        submitted_at,
        status
      ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
      ON CONFLICT (slash_request_id, identity) DO NOTHING
      RETURNING id, slash_request_id, identity, evidence, stake, status, submitted_at
      `,
      [
        input.id,
        input.slashRequestId,
        input.identity,
        JSON.stringify(input.evidence),
        input.stake,
        input.submittedAt.toISOString(),
        'submitted',
      ]
    )

    const row = result.rows[0]
    if (!row) {
      return null
    }

    return {
      id: row.id,
      slashRequestId: row.slash_request_id,
      identity: row.identity,
      evidence: row.evidence,
      stake: row.stake,
      status: row.status,
      submittedAt: new Date(row.submitted_at),
    }
  }

  async markSlashRequestDisputed(id: string): Promise<void> {
    await this.client.query(
      `
      UPDATE slash_requests
      SET status = 'disputed'
      WHERE id = $1
      `,
      [id]
    )
  }
}

/**
 * Default internal event publisher used by API wiring.
 */
export class ConsoleArbitrationEventPublisher implements ArbitrationEventPublisher {
  async publishDisputeSubmitted(event: DisputeSubmittedEvent): Promise<void> {
    console.info('Arbitration event emitted', event)
  }
}

/**
 * Service that validates and submits disputes against slash requests.
 */
export class DisputeSubmissionService {
  constructor(
    private readonly repository: DisputeSubmissionRepository,
    private readonly publisher: ArbitrationEventPublisher
  ) {}

  /**
   * Submits a dispute and emits arbitration event after successful persistence.
   */
  async submit(input: DisputeSubmissionInput): Promise<PersistedDisputeSubmission> {
    const errors = validateDisputeSubmissionInput(input)
    if (errors.length > 0) {
      throw new DisputeSubmissionError('VALIDATION_ERROR', errors.join('; '))
    }

    const dispute = await this.repository.withTransaction(async (tx) => {
      const slashRequest = await tx.getSlashRequestForUpdate(input.slashRequestId)
      if (!slashRequest) {
        throw new DisputeSubmissionError(
          'SLASH_REQUEST_NOT_FOUND',
          'slash request does not exist'
        )
      }
      if (slashRequest.identity !== input.identity) {
        throw new DisputeSubmissionError(
          'IDENTITY_MISMATCH',
          'identity does not match slash request'
        )
      }
      if (!DISPUTABLE_STATUSES.has(slashRequest.status)) {
        throw new DisputeSubmissionError(
          'NOT_DISPUTABLE',
          `slash request is not disputable (status=${slashRequest.status})`
        )
      }
      if (new Date() > slashRequest.disputableUntil) {
        throw new DisputeSubmissionError(
          'DEADLINE_PASSED',
          'dispute submission deadline has passed'
        )
      }

      const inserted = await tx.insertDispute({
        id: randomUUID(),
        slashRequestId: input.slashRequestId,
        identity: input.identity,
        evidence: input.evidence,
        stake: input.stake ?? null,
        submittedAt: new Date(),
      })
      if (!inserted) {
        throw new DisputeSubmissionError(
          'ALREADY_DISPUTED',
          'dispute already submitted for this slash request and identity'
        )
      }

      await tx.markSlashRequestDisputed?.(input.slashRequestId)
      return inserted
    })

    try {
      await this.publisher.publishDisputeSubmitted({
        type: 'governance.dispute_submitted',
        dispute_id: dispute.id,
        slash_request_id: dispute.slashRequestId,
        identity: dispute.identity,
        submitted_at: dispute.submittedAt.toISOString(),
        stake: dispute.stake,
        evidence_count: dispute.evidence.length,
      })
    } catch (error) {
      throw new DisputeSubmissionError(
        'EVENT_PUBLISH_FAILED',
        error instanceof Error ? error.message : 'failed to publish arbitration event'
      )
    }

    return dispute
  }
}

/**
 * Validates dispute submission payload.
 */
export function validateDisputeSubmissionInput(input: DisputeSubmissionInput): string[] {
  const errors: string[] = []

  if (!input.slashRequestId || typeof input.slashRequestId !== 'string') {
    errors.push('slash_request_id is required')
  }

  if (!input.identity || typeof input.identity !== 'string') {
    errors.push('identity is required')
  } else if (!STELLAR_ADDRESS_RE.test(input.identity)) {
    errors.push('identity must be a valid Stellar address')
  }

  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    errors.push('evidence must contain at least one item')
  } else if (input.evidence.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    errors.push('evidence items must be non-empty strings')
  }

  if (input.stake !== undefined) {
    if (typeof input.stake !== 'string' || input.stake.trim().length === 0) {
      errors.push('stake must be a non-empty string when provided')
    } else if (!/^\d+(\.\d+)?$/.test(input.stake)) {
      errors.push('stake must be a numeric string')
    }
  }

  return errors
}
