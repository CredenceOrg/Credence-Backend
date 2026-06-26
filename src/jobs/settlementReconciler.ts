import { Horizon } from '@stellar/stellar-sdk'
import type { Queryable } from '../db/repositories/queryable.js'
import { recordSettlementDrift } from '../middleware/metrics.js'
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
            })

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
            })

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

    return { checked, discrepancies, errors }
  }

  /**
   * Persists a reconciliation finding to the database
   */
  private async recordFinding(
    settlementId: string,
    findingType: 'state_mismatch' | 'missing_on_chain',
    details: Record<string, any>
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
