import { createHash } from 'node:crypto'
import type {
  AuditLogEntry,
  ChainVerificationResult,
  ChainViolation,
} from '../services/audit/types.js'
import { computeRowHash } from '../db/repositories/auditLogsRepository.js'

/**
 * Minimal read-only DB interface used by the verifier.
 * The verifier MUST run with a read-only database role to limit blast radius.
 */
export interface ReadOnlyAuditDb {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

/**
 * Metrics sink interface for the verifier to emit Prometheus counters.
 */
export interface AuditChainMetrics {
  /** Increment the violation counter */
  incViolation(count?: number): void
  /** Set the total rows checked gauge */
  setRowsChecked(count: number): void
  /** Set the last run timestamp gauge */
  setLastRunTimestamp(timestamp: number): void
  /** Set whether the last run was valid (1) or not (0) */
  setLastRunValid(valid: boolean): void
}

/**
 * No-op metrics sink for testing.
 */
export class NoOpAuditChainMetrics implements AuditChainMetrics {
  incViolation(_count?: number): void {}
  setRowsChecked(_count: number): void {}
  setLastRunTimestamp(_timestamp: number): void {}
  setLastRunValid(_valid: boolean): void {}
}

/**
 * Console-based metrics sink that logs violations.
 * Suitable for development and early production before Prometheus is wired up.
 */
export class ConsoleAuditChainMetrics implements AuditChainMetrics {
  public violationCount = 0
  public rowsChecked = 0
  public lastRunTimestamp = 0
  public lastRunValid = true

  incViolation(count = 1): void {
    this.violationCount += count
    console.error(`[audit-chain-verifier] VIOLATION count incremented to ${this.violationCount}`)
  }

  setRowsChecked(count: number): void {
    this.rowsChecked = count
  }

  setLastRunTimestamp(timestamp: number): void {
    this.lastRunTimestamp = timestamp
  }

  setLastRunValid(valid: boolean): void {
    this.lastRunValid = valid
    if (!valid) {
      console.error('[audit-chain-verifier] Chain integrity FAILED')
    }
  }
}

/**
 * Row shape returned by the chain verification query.
 */
interface AuditChainRow {
  id: string
  seq: number
  occurred_at: string | Date
  actor_id: string
  action: string
  resource_type: string
  resource_id: string
  details_json: Record<string, unknown> | null
  status: string
  tenant_id: string
  prev_hash: string | null
  row_hash: string | null
}

export interface AuditChainVerifierOptions {
  /** Batch size when reading rows (default: 1000) */
  batchSize?: number
  /** Maximum number of violations to collect before stopping (default: 100) */
  maxViolations?: number
  /** Logger function */
  logger?: (message: string) => void
}

/**
 * AuditChainVerifier walks the audit_logs table in seq order and verifies
 * that each row's prev_hash matches the row_hash of the previous row,
 * and that each row_hash is correctly computed from the row's content.
 *
 * SECURITY: This verifier MUST be configured with a read-only database role
 * to limit blast radius. It should never be able to write to the audit_logs table.
 *
 * The verifier emits the `audit_chain_integrity_violation_total` Prometheus counter
 * so that Alertmanager can page on-call when any tampering is detected.
 *
 * Schedule: every 15 minutes via the job scheduler.
 */
export class AuditChainVerifier {
  private readonly batchSize: number
  private readonly maxViolations: number
  private readonly logger: (message: string) => void

  constructor(
    private readonly db: ReadOnlyAuditDb,
    private readonly metrics: AuditChainMetrics = new NoOpAuditChainMetrics(),
    options: AuditChainVerifierOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 1000
    this.maxViolations = options.maxViolations ?? 100
    this.logger = options.logger ?? (() => {})
  }

  /**
   * Run a full chain verification.
   *
   * Walks the chain from seq=1 (genesis) to the latest row, checking:
   * 1. prev_hash of row N matches row_hash of row N-1
   * 2. row_hash is the correct SHA-256 of the row's content
   * 3. No gaps in the sequence (deleted rows)
   *
   * @returns Verification result with violation details
   */
  async verify(): Promise<ChainVerificationResult> {
    const startTime = Date.now()
    const violations: ChainViolation[] = []
    let rowsChecked = 0
    let prevRowHash: string | null = null
    let prevSeq: number | null = null
    let lastSeq = 0

    this.logger('[audit-chain-verifier] Starting chain verification...')

    try {
      let hasMore = true
      while (hasMore && violations.length < this.maxViolations) {
        const rows = await this.fetchBatch(lastSeq)

        if (rows.length === 0) {
          hasMore = false
          break
        }

        for (const row of rows) {
          rowsChecked++

          // Check for sequence gaps (deleted rows)
          if (prevSeq !== null && row.seq !== prevSeq + 1) {
            violations.push({
              seq: row.seq,
              id: row.id,
              expectedPrevHash: prevRowHash,
              actualPrevHash: row.prev_hash,
              expectedRowHash: '',
              actualRowHash: row.row_hash,
              type: 'deleted_row',
            })

            if (violations.length >= this.maxViolations) break
          }

          // Check prev_hash linkage
          if (row.prev_hash !== prevRowHash) {
            // Allow null === undefined mismatch tolerance
            const prevMismatch =
              (prevRowHash === null && row.prev_hash !== null) ||
              (prevRowHash !== null && row.prev_hash !== prevRowHash)

            if (prevMismatch) {
              violations.push({
                seq: row.seq,
                id: row.id,
                expectedPrevHash: prevRowHash,
                actualPrevHash: row.prev_hash,
                expectedRowHash: '',
                actualRowHash: row.row_hash,
                type: 'prev_hash_mismatch',
              })

              if (violations.length >= this.maxViolations) break
            }
          }

          // Recompute and verify row_hash
          const occurredAt = row.occurred_at instanceof Date
            ? row.occurred_at.toISOString()
            : String(row.occurred_at)

          const detailsStr = row.details_json !== null
            ? JSON.stringify(row.details_json)
            : '{}'

          const expectedHash = computeRowHash(
            row.prev_hash,
            row.id,
            occurredAt,
            row.actor_id,
            row.action,
            row.resource_type,
            row.resource_id,
            detailsStr,
            row.status,
            row.tenant_id,
          )

          if (row.row_hash !== expectedHash) {
            violations.push({
              seq: row.seq,
              id: row.id,
              expectedPrevHash: prevRowHash,
              actualPrevHash: row.prev_hash,
              expectedRowHash: expectedHash,
              actualRowHash: row.row_hash,
              type: 'row_hash_mismatch',
            })

            if (violations.length >= this.maxViolations) break
          }

          prevRowHash = row.row_hash
          prevSeq = row.seq
          lastSeq = row.seq
        }

        if (rows.length < this.batchSize) {
          hasMore = false
        }
      }
    } catch (error) {
      this.logger(`[audit-chain-verifier] Error during verification: ${error}`)
      throw error
    }

    const result: ChainVerificationResult = {
      valid: violations.length === 0,
      rowsChecked,
      violationCount: violations.length,
      violations,
      checkedAt: new Date().toISOString(),
    }

    if (violations.length > 0) {
      result.firstViolationSeq = violations[0].seq
      result.firstViolationId = violations[0].id
    }

    // Emit metrics
    this.metrics.setRowsChecked(rowsChecked)
    this.metrics.setLastRunTimestamp(Date.now())
    this.metrics.setLastRunValid(result.valid)

    if (violations.length > 0) {
      this.metrics.incViolation(violations.length)
      this.logger(
        `[audit-chain-verifier] INTEGRITY VIOLATION: ${violations.length} violations found in ${rowsChecked} rows`
      )
    } else {
      this.logger(
        `[audit-chain-verifier] Chain OK: ${rowsChecked} rows verified in ${Date.now() - startTime}ms`
      )
    }

    return result
  }

  /**
   * Fetch a batch of audit log rows ordered by seq, starting after lastSeq.
   */
  private async fetchBatch(afterSeq: number): Promise<AuditChainRow[]> {
    const result = await this.db.query<AuditChainRow>(
      `
      SELECT
        id,
        seq,
        occurred_at,
        actor_id,
        action,
        resource_type,
        resource_id,
        details_json,
        status,
        tenant_id,
        prev_hash,
        row_hash
      FROM audit_logs
      WHERE seq > $1
      ORDER BY seq ASC
      LIMIT $2
      `,
      [afterSeq, this.batchSize],
    )

    return result.rows
  }
}

/**
 * Factory to create and run the verifier as a scheduled job.
 * Intended to be called by the scheduler every 15 minutes.
 */
export async function runAuditChainVerification(
  db: ReadOnlyAuditDb,
  metrics: AuditChainMetrics = new NoOpAuditChainMetrics(),
  options: AuditChainVerifierOptions = {},
): Promise<ChainVerificationResult> {
  const verifier = new AuditChainVerifier(db, metrics, options)
  return verifier.verify()
}
