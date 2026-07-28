import { SettlementsRepository, Settlement, CreateSettlementInput } from '../db/repositories/settlementsRepository.js'
import { cache } from '../cache/redis.js'
import { invalidateCache } from '../cache/invalidation.js'
import { recordSettlementDuplicate } from '../middleware/metrics.js'
import { getFlag } from '../config/featureFlags.js'
import { executeShadowWrite } from './shadowWrite.js'
import type { CreatePayoutInput } from '../schemas/payout.js'

export class SettlementService {
  constructor(private readonly repository: SettlementsRepository) {}

  /**
   * Fetches the settlement by transaction hash.
   * Utilizes cache with TTL to preserve behavior for unchanged records.
   */
  async getSettlementByHash(transactionHash: string): Promise<Settlement | null> {
    const isLocked = await isCacheLocked('settlement', transactionHash)
    if (isLocked) {
      return this.repository.findByTransactionHash(transactionHash)
    }

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
  async upsertSettlementStatus(input: CreatePayoutInput): Promise<Settlement> {
    const repoInput: CreateSettlementInput = {
      bondId: input.bondId,
      amount: input.amount,
      transactionHash: input.transactionHash,
      settledAt: input.settledAt ? new Date(input.settledAt) : undefined,
      status: input.status,
    }

    let settlement: Settlement
    let isDuplicate: boolean

    const shadowWriteEnabled = getFlag('shadowWriteMode') && getFlag('newPipeline')

    if (shadowWriteEnabled) {
      const shadowResult = await executeShadowWrite(this.repository, this.repository, repoInput)
      settlement = shadowResult.primaryResult.settlement
      isDuplicate = shadowResult.primaryResult.isDuplicate
    } else {
      const result = await this.repository.upsert(repoInput)
      settlement = result.settlement
      isDuplicate = result.isDuplicate
    }
    
    // Record metric when duplicate settlement is detected and collapsed via transaction_hash idempotency
    if (isDuplicate) {
      recordSettlementDuplicate()
    }

    // Lock the id too now that we have it
    await acquireCacheLock('settlement', `id:${settlement.id}`)
    
    // Post-commit hook: invalidate all keys related to this settlement
    await invalidateMultiple('settlement', [
      settlement.transactionHash,
      `id:${settlement.id}`,
      `bondId:${settlement.bondId}`
    ])

    // Verify cache is cleared after commit (stale-read detection)
    runPostCommit(async () => {
      const staleCheck = await cache.get<Settlement>('settlement', settlement.transactionHash)
      if (staleCheck && staleCheck.status !== settlement.status) {
        recordStaleCacheRead('settlement')
        console.warn(`Stale cache detected for settlement:${settlement.transactionHash}`)
      }
    })

    return settlement
  }
}
