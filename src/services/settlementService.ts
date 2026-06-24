import { SettlementsRepository, Settlement, CreateSettlementInput } from '../db/repositories/settlementsRepository.js'
import { cache } from '../cache/redis.js'
import { invalidateCache } from '../cache/invalidation.js'
import { recordSettlementDuplicate } from '../middleware/metrics.js'
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
   */
  async upsertSettlementStatus(input: CreateSettlementInput): Promise<Settlement> {
    const { settlement, isDuplicate } = await this.repository.upsert(input)
    
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
