import { SettlementsRepository, Settlement, CreateSettlementInput } from '../db/repositories/settlementsRepository.js'
import { cache } from '../cache/redis.js'
import { recordStaleCacheRead } from '../middleware/metrics.js'

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
   * Cache invalidation hook is executed post-commit (after DB update).
   */
  async upsertSettlementStatus(input: CreateSettlementInput): Promise<Settlement> {
    const { settlement } = await this.repository.upsert(input)
    
    // Post-commit hook: invalidate the cache immediately after status mutation
    await cache.delete('settlement', settlement.transactionHash)
    
    // Fallback stale-read detection metric
    // Verify that the cache actually cleared, checking if another process concurrently overwrote it with stale data
    const staleCheck = await cache.get<Settlement>('settlement', settlement.transactionHash)
    if (staleCheck && staleCheck.status !== settlement.status) {
      recordStaleCacheRead('settlement')
    }

    return settlement
  }
}
