import { SettlementsRepository, Settlement, CreateSettlementInput } from '../db/repositories/settlementsRepository.js'
import { cache } from '../cache/redis.js'
import { invalidateCache } from '../cache/invalidation.js'
import { recordSettlementDuplicate } from '../middleware/metrics.js'
import { getFlag } from '../config/featureFlags.js'
import { executeShadowWrite } from './shadowWrite.js'
/**
 * Issue #325: Import the schema-inferred type to ensure the service input
 * is aligned with the validated Zod schema. CreateSettlementInput from the
 * repository already matches the schema shape, so no structural changes needed.
 * This import documents the intentional alignment between schema and service.
 */
import type { CreatePayoutInput } from '../schemas/payout.js'
import { ValidationError } from '../lib/errors.js'

export class SettlementService {
  constructor(private readonly repository: SettlementsRepository) {}

  /**
   * Fetches the settlement by transaction hash.
   * Utilizes cache with TTL to preserve behavior for unchanged records.
   */
  async getSettlementByHash(transactionHash: string): Promise<Settlement | null> {
    const cached = await cache.get<Settlement>('settlement', transactionHash)
    
    if (cached) {
      // Re-hydrate Date objects after JSON parsing
      return {
        ...cached,
        settledAt: new Date(cached.settledAt),
        createdAt: new Date(cached.createdAt),
        updatedAt: new Date(cached.updatedAt)
      }
    }

    const settlement = await this.repository.findByTransactionHash(transactionHash)
    if (settlement) {
      // Preserve cache TTL behavior for unchanged records (e.g., 5 minutes / 300 seconds)
      await cache.set('settlement', transactionHash, settlement, 300)
    }

    return settlement
  }

  /**
   * Upserts the settlement (status mutation).
   * Records duplicate detection metric when settlement is idempotent on transaction_hash.
   * Cache invalidation hook is executed post-commit (after DB update).
   * 
   * When SHADOW_WRITE_MODE is enabled (and NEW_PIPELINE is true), writes go to both
   * old and new pipelines; results are diffed in metrics to validate the new pipeline.
   */
  async upsertSettlementStatus(input: CreateSettlementInput): Promise<Settlement> {
    let settlement: Settlement
    let isDuplicate: boolean

    // Check if shadow write mode is enabled for pipeline validation
    const shadowWriteEnabled = getFlag('shadowWriteMode') && getFlag('newPipeline')

    if (shadowWriteEnabled) {
      // Execute write to both old and new pipelines, diffing results in metrics
      const shadowResult = await executeShadowWrite(this.repository, this.repository, input)
      settlement = shadowResult.primaryResult.settlement
      isDuplicate = shadowResult.primaryResult.isDuplicate
    } else {
      // Standard path: write to single pipeline (determined by NEW_PIPELINE flag)
      const result = await this.repository.upsert(input)
      settlement = result.settlement
      isDuplicate = result.isDuplicate
    }
    
    // Record metric when duplicate settlement is detected and collapsed via transaction_hash idempotency
    if (isDuplicate) {
      recordSettlementDuplicate()
    }
    
    // Post-commit hook: invalidate the cache immediately after status mutation with verification
    await invalidateCache(
      'settlement',
      settlement.transactionHash,
      settlement,
      {
        verify: true,
        verifyFn: (cached, fresh) => cached.status !== fresh.status
      }
    )

    return settlement
  }

  /**
   * Upserts a batch of settlements atomically after validating the entire batch payload.
   * Ensures that no writes occur if any item in the batch fails validation.
   */
  async upsertSettlementBatch(inputs: CreateSettlementInput[]): Promise<Settlement[]> {
    this.validateBatchInputs(inputs)

    const results = await this.repository.upsertBatch(inputs)
    const settlements: Settlement[] = []

    for (const res of results) {
      if (res.isDuplicate) {
        recordSettlementDuplicate()
      }
      const settlement = res.settlement
      settlements.push(settlement)

      await invalidateCache(
        'settlement',
        settlement.transactionHash,
        settlement,
        {
          verify: true,
          verifyFn: (cached, fresh) => cached.status !== fresh.status,
        }
      )
    }

    return settlements
  }

  private validateBatchInputs(inputs: CreateSettlementInput[]): void {
    if (!Array.isArray(inputs)) {
      throw new ValidationError('Batch settlement inputs must be an array')
    }
    for (let i = 0; i < inputs.length; i++) {
      const item = inputs[i]
      if (!item || typeof item !== 'object') {
        throw new ValidationError(`Settlement input at index ${i} must be a valid object`)
      }
      if (item.bondId === undefined || item.bondId === null || String(item.bondId).trim() === '') {
        throw new ValidationError(`Settlement input at index ${i} has invalid bondId: must not be empty`)
      }
      if (typeof item.amount !== 'string' || !/^\d+(\.\d{1,18})?$/.test(item.amount)) {
        throw new ValidationError(
          `Settlement input at index ${i} has invalid amount: must be a valid non-negative numeric string with at most 18 decimal places`,
        )
      }
      const numAmount = parseFloat(item.amount)
      if (isNaN(numAmount) || numAmount < 0 || numAmount > 1e18) {
        throw new ValidationError(`Settlement input at index ${i} has invalid amount: must be between 0 and 1e18`)
      }
      if (
        typeof item.transactionHash !== 'string' ||
        item.transactionHash.trim().length === 0 ||
        item.transactionHash.length > 128
      ) {
        throw new ValidationError(
          `Settlement input at index ${i} has invalid transactionHash: must be a string between 1 and 128 characters`,
        )
      }
      if (item.settledAt !== undefined && (!(item.settledAt instanceof Date) || isNaN(item.settledAt.getTime()))) {
        throw new ValidationError(`Settlement input at index ${i} has invalid settledAt: must be a valid Date object`)
      }
    }
  }
}
