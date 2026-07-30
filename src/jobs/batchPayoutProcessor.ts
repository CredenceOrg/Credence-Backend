import type { SettlementStatus } from '../types/index.js'
import { ValidationError } from '../lib/errors.js'

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

  /**
   * Validates the entire payload before applying any writes (atomic semantics).
   * Throws a ValidationError immediately if any item in the batch is invalid.
   */
  public validatePayload(items: PayoutItem[]): void {
    if (!Array.isArray(items)) {
      throw new ValidationError('Batch payout payload must be an array of items')
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || typeof item !== 'object') {
        throw new ValidationError(`Item at index ${i} must be a valid payout item object`)
      }
      if (item.bondId === undefined || item.bondId === null || String(item.bondId).trim() === '') {
        throw new ValidationError(`Item at index ${i} has invalid bondId: must not be empty`)
      }
      if (typeof item.amount !== 'string' || !/^\d+(\.\d{1,18})?$/.test(item.amount)) {
        throw new ValidationError(
          `Item at index ${i} has invalid amount: must be a valid non-negative numeric string with at most 18 decimal places`,
        )
      }
      const numAmount = parseFloat(item.amount)
      if (isNaN(numAmount) || numAmount < 0 || numAmount > 1e18) {
        throw new ValidationError(`Item at index ${i} has invalid amount: must be between 0 and 1e18`)
      }
      if (
        typeof item.transactionHash !== 'string' ||
        item.transactionHash.trim().length === 0 ||
        item.transactionHash.length > 128
      ) {
        throw new ValidationError(
          `Item at index ${i} has invalid transactionHash: must be a string between 1 and 128 characters`,
        )
      }
      if (item.settledAt !== undefined && (!(item.settledAt instanceof Date) || isNaN(item.settledAt.getTime()))) {
        throw new ValidationError(`Item at index ${i} has invalid settledAt: must be a valid Date object`)
      }
    }
  }

  async process(items: PayoutItem[]): Promise<BatchPayoutResult> {
    this.validatePayload(items)
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
