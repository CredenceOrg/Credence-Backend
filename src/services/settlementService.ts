import { SettlementsRepository, Settlement, CreateSettlementInput } from '../db/repositories/settlementsRepository.js'
import { cache } from '../cache/redis.js'
import { invalidateCache } from '../cache/invalidation.js'
import { recordSettlementDuplicate } from '../middleware/metrics.js'
import { getFlag } from '../config/featureFlags.js'
import { executeShadowWrite } from './shadowWrite.js'
import { withRetryableTransaction } from '../db/retry.js'
import { pool } from '../db/pool.js'
/**
 * Issue #325: Import the schema-inferred type to ensure the service input
 * is aligned with the validated Zod schema. CreateSettlementInput from the
 * repository already matches the schema shape, so no structural changes needed.
 * This import documents the intentional alignment between schema and service.
 */
import type { CreatePayoutInput } from '../schemas/payout.js'

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
   * 
   * Wrapped in withRetryableTransaction to handle transient PostgreSQL errors
   * (serialization failures, deadlocks) with exponential backoff retry.
   */
  async upsertSettlementStatus(input: CreateSettlementInput): Promise<Settlement> {
    // Wrap critical write in retryable transaction to handle transient failures
    const { settlement, isDuplicate } = await withRetryableTransaction(
      pool,
      async (client) => {
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

        return { settlement, isDuplicate }
      },
      {
        maxRetries: 3,
        operationName: 'upsert-settlement-status',
      }
    )
    
    // Post-commit side effects: these run AFTER the transaction successfully commits
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
}
