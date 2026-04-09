import type { SettlementStatus } from '../types/index.js'

/**
 * A single payout item in a batch.
 */
export interface PayoutItem {
  bondId: string
  amount: string
  transactionHash: string
  settledAt?: Date
}

/**
 * Per-item result after processing.
 */
export interface PayoutItemResult {
  bondId: string
  transactionHash: string
  status: SettlementStatus
  error?: string
  retryEligible: boolean
}

/**
 * Aggregate summary of a batch payout run.
 */
export interface BatchPayoutResult {
  total: number
  settled: number
  failed: number
  skipped: number
  items: PayoutItemResult[]
  duration: number
  startTime: string
}

/**
 * Abstraction over the settlement persistence layer so the processor
 * is testable without a real database.
 */
export interface PayoutSettlementStore {
  upsert(input: {
    bondId: string
    amount: string
    transactionHash: string
    settledAt?: Date
    status?: SettlementStatus
  }): Promise<{ isDuplicate: boolean }>
}

/**
 * Abstraction over the actual on-chain (or gateway) payout execution.
 */
export interface PayoutExecutor {
  execute(item: PayoutItem): Promise<void>
}

export interface BatchPayoutOptions {
  logger?: (message: string) => void
}

/**
 * Processes a batch of payouts with per-item isolation.
 *
 * Each item is executed and persisted independently so that a single
 * failure never corrupts the status of other items in the batch.
 * Failed items are marked as retry-eligible; already-processed
 * (duplicate) items are skipped.
 */
export class BatchPayoutProcessor {
  private readonly logger: (message: string) => void

  constructor(
    private readonly store: PayoutSettlementStore,
    private readonly executor: PayoutExecutor,
    options: BatchPayoutOptions = {},
  ) {
    this.logger = options.logger ?? (() => {})
  }

  async process(items: PayoutItem[]): Promise<BatchPayoutResult> {
    const startTime = new Date().toISOString()
    const startMs = Date.now()

    const results: PayoutItemResult[] = []
    let settled = 0
    let failed = 0
    let skipped = 0

    for (const item of items) {
      const result = await this.processItem(item)
      results.push(result)

      if (result.status === 'settled') settled++
      else if (result.status === 'failed') failed++
      else skipped++
    }

    const duration = Date.now() - startMs
    this.logger(
      `Batch complete: ${items.length} total, ${settled} settled, ${failed} failed, ${skipped} skipped (${duration}ms)`,
    )

    return {
      total: items.length,
      settled,
      failed,
      skipped,
      items: results,
      duration,
      startTime,
    }
  }

  private async processItem(item: PayoutItem): Promise<PayoutItemResult> {
    // 1. Record as pending
    try {
      const { isDuplicate } = await this.store.upsert({
        bondId: item.bondId,
        amount: item.amount,
        transactionHash: item.transactionHash,
        settledAt: item.settledAt,
        status: 'pending',
      })

      if (isDuplicate) {
        this.logger(`Skipping duplicate: ${item.transactionHash}`)
        return {
          bondId: item.bondId,
          transactionHash: item.transactionHash,
          status: 'pending',
          retryEligible: false,
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.logger(`Failed to record payout ${item.transactionHash}: ${message}`)
      return {
        bondId: item.bondId,
        transactionHash: item.transactionHash,
        status: 'failed',
        error: message,
        retryEligible: true,
      }
    }

    // 2. Execute payout
    try {
      await this.executor.execute(item)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.logger(`Payout execution failed for ${item.transactionHash}: ${message}`)

      // Mark as failed in store — best effort
      try {
        await this.store.upsert({
          bondId: item.bondId,
          amount: item.amount,
          transactionHash: item.transactionHash,
          settledAt: item.settledAt,
          status: 'failed',
        })
      } catch {
        this.logger(`Could not persist failure status for ${item.transactionHash}`)
      }

      return {
        bondId: item.bondId,
        transactionHash: item.transactionHash,
        status: 'failed',
        error: message,
        retryEligible: true,
      }
    }

    // 3. Mark as settled
    try {
      await this.store.upsert({
        bondId: item.bondId,
        amount: item.amount,
        transactionHash: item.transactionHash,
        settledAt: item.settledAt,
        status: 'settled',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.logger(`Failed to mark ${item.transactionHash} as settled: ${message}`)
      // Execution succeeded but persistence failed — still retry-eligible
      // so the status can be reconciled.
      return {
        bondId: item.bondId,
        transactionHash: item.transactionHash,
        status: 'failed',
        error: `Payout executed but status update failed: ${message}`,
        retryEligible: true,
      }
    }

    return {
      bondId: item.bondId,
      transactionHash: item.transactionHash,
      status: 'settled',
      retryEligible: false,
    }
  }
}

/**
 * Filter a batch result to only the items eligible for retry.
 */
export function getRetryableItems(
  original: PayoutItem[],
  result: BatchPayoutResult,
): PayoutItem[] {
  const retryHashes = new Set(
    result.items
      .filter((r) => r.retryEligible)
      .map((r) => r.transactionHash),
  )
  return original.filter((item) => retryHashes.has(item.transactionHash))
}
