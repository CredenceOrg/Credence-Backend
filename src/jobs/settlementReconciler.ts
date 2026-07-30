import { Horizon } from '@stellar/stellar-sdk'
import type { Queryable } from '../db/repositories/queryable.js'
import { recordSettlementDrift, setSettlementUnmatchedCount } from '../middleware/metrics.js'
import { logger } from '../utils/logger.js'

export interface SettlementReconcilerOptions {
  /** Sliding reconciliation window in milliseconds (default: 24 hours) */
  windowMs?: number
  /** Grace period in milliseconds for pending settlements before flagging as missing (default: 5 minutes) */
  gracePeriodMs?: number
  /** Stellar Horizon URL (optional, defaults to config/env or testnet) */
  horizonUrl?: string
  /** Logger function */
  logger?: (msg: string) => void
}

export interface ReconciliationResult {
  /** UUID of the persisted run row (null when persistence fails). */
  runId: string | null
  checked: number
  discrepancies: number
  errors: number
}

export class SettlementReconciler {
  private readonly windowMs: number
  private readonly gracePeriodMs: number
  private readonly horizonServer: Horizon.Server
  private readonly log: (msg: string) => void

  constructor(
    private readonly db: Queryable,
    options: SettlementReconcilerOptions = {}
  ) {
    this.windowMs = options.windowMs ?? 24 * 60 * 60 * 1000 // 24 hours
    this.gracePeriodMs = options.gracePeriodMs ?? 5 * 60 * 1000 // 5 minutes
    const url = options.horizonUrl || process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org'
    this.horizonServer = new Horizon.Server(url)
    this.log = options.logger ?? ((msg) => logger.info(msg))
  }

  /**
   * Run the settlement reconciliation job
   */
  async run(): Promise<ReconciliationResult> {
    this.log('[SettlementReconciler] Starting reconciliation run')
    const startMs = Date.now()

    let runId: string | null = null
    let checked = 0
    let discrepancies = 0
    let errors = 0

    try {
      // Fetch settlements updated within the sliding window
      const cutoffDate = new Date(Date.now() - this.windowMs)
      const res = await this.db.query<{
        id: string
        status: 'pending' | 'settled' | 'failed'
        transaction_hash: string
        amount: string
        updated_at: Date | string
      }>(
        `SELECT id, status, transaction_hash, amount, updated_at
         FROM settlements
         WHERE updated_at >= $1`,
        [cutoffDate]
      )

      const settlements = res.rows
      this.log(`[SettlementReconciler] Found ${settlements.length} settlements to reconcile`)

      for (const settlement of settlements) {
        const hash = settlement.transaction_hash

        if (!hash) {
          this.log(`[SettlementReconciler] Settlement ${settlement.id} is missing transaction_hash, skipping`)
          continue
        }

        // Apply grace period for pending transactions to avoid race conditions
        const isPending = settlement.status === 'pending'
        const ageMs = Date.now() - new Date(settlement.updated_at).getTime()
        const isRecentPending = isPending && ageMs < this.gracePeriodMs

        if (isRecentPending) {
          this.log(`[SettlementReconciler] Settlement ${settlement.id} is pending and recent (${Math.round(ageMs / 1000)}s old), skipping`)
          continue
        }

        checked++

        try {
          // Fetch transaction from Stellar Horizon (Read-only query)
          const tx = await this.horizonServer.transactions().transaction(hash).call()
          const chainStatus = tx.successful ? 'settled' : 'failed'

          if (settlement.status !== chainStatus) {
            discrepancies++
            this.log(
              `[SettlementReconciler] Mismatch for settlement ${settlement.id}: internalStatus=${settlement.status}, chainStatus=${chainStatus}`
            )

            await this.recordFinding(settlement.id, 'state_mismatch', {
              internalStatus: settlement.status,
              chainStatus,
              transactionHash: hash,
              amount: settlement.amount,
              updatedAt: settlement.updated_at
            }, runId)

            recordSettlementDrift('state_mismatch')
          }
        } catch (err: any) {
          // If transaction is not found (404)
          if (err?.response?.status === 404) {
            discrepancies++
            this.log(
              `[SettlementReconciler] Settlement ${settlement.id} exists internally but transaction ${hash} was not found on Stellar`
            )

            await this.recordFinding(settlement.id, 'missing_on_chain', {
              internalStatus: settlement.status,
              transactionHash: hash,
              amount: settlement.amount,
              updatedAt: settlement.updated_at,
              error: 'Transaction not found on Stellar Horizon'
            }, runId)

            recordSettlementDrift('missing_on_chain')
          } else {
            errors++
            const errMsg = err?.message || String(err)
            this.log(
              `[SettlementReconciler] Error querying transaction ${hash} for settlement ${settlement.id}: ${errMsg}`
            )
          }
        }
      }
    } catch (err: any) {
      errors++
      this.log(`[SettlementReconciler] Unexpected error during reconciliation: ${err?.message || err}`)
    }

    const durationMs = Date.now() - startMs
    this.log(
      `[SettlementReconciler] Reconciliation run finished. checked=${checked} discrepancies=${discrepancies} errors=${errors} duration=${durationMs}ms`
    )

    // Persist run summary
    runId = await this.persistRunSummary(checked, discrepancies, errors)

    // Update linked findings with the run_id
    // (findings were inserted during the loop above without a run_id;
    //  we patch them now that we have the run row)
    if (runId && discrepancies > 0) {
      await this.linkFindingsToRun(runId)
    }

    // Update the Prometheus gauge
    setSettlementUnmatchedCount(discrepancies)

    return { runId, checked, discrepancies, errors }
  }

  /**
   * Persists a reconciliation run summary to the database.
   * @returns The UUID of the created run row, or null on failure.
   */
  private async persistRunSummary(
    checked: number,
    discrepancies: number,
    errors: number
  ): Promise<string | null> {
    try {
      const res = await this.db.query<{ id: string }>(
        `INSERT INTO settlement_reconciliation_runs (checked, discrepancies, errors)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [checked, discrepancies, errors]
      )
      return res.rows[0]?.id ?? null
    } catch (err: any) {
      this.log(
        `[SettlementReconciler] Failed to persist run summary: ${err?.message || err}`
      )
      return null
    }
  }

  /**
   * Links findings that were created during this run (with NULL run_id)
   * to the newly created run row.
   */
  private async linkFindingsToRun(runId: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE settlement_reconciliation_findings
         SET run_id = $1
         WHERE run_id IS NULL`,
        [runId]
      )
    } catch (err: any) {
      this.log(
        `[SettlementReconciler] Failed to link findings to run ${runId}: ${err?.message || err}`
      )
    }
  }

  /**
   * Persists a reconciliation finding to the database.
   */
  private async recordFinding(
    settlementId: string,
    findingType: 'state_mismatch' | 'missing_on_chain',
    details: Record<string, any>,
    _runId: string | null
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO settlement_reconciliation_findings (settlement_id, finding_type, details)
         VALUES ($1, $2, $3)
         ON CONFLICT (settlement_id, finding_type) DO UPDATE
         SET details = EXCLUDED.details, created_at = NOW()`,
        [settlementId, findingType, JSON.stringify(details)]
      )
    } catch (err: any) {
      this.log(
        `[SettlementReconciler] Failed to save finding for settlement ${settlementId}: ${err?.message || err}`
      )
    }
  }
}
