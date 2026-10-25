import type { Queryable } from '../db/repositories/queryable.js'
import {
  SettlementsRepository,
  type CreateSettlementInput,
  type UpsertSettlementResult,
} from '../db/repositories/settlementsRepository.js'
import type { PayoutSettlementStore } from '../jobs/batchPayoutProcessor.js'
import type { SettlementStatus } from '../types/index.js'

/**
 * Repository adapter implementing PayoutSettlementStore for BatchPayoutProcessor.
 * Provides both item-level idempotency checks and atomic batch persistence.
 */
export class BatchPayoutRepository implements PayoutSettlementStore {
  private readonly settlementsRepo: SettlementsRepository

  constructor(private readonly db: Queryable) {
    this.settlementsRepo = new SettlementsRepository(db)
  }

  async upsert(input: {
    bondId: string
    amount: string
    transactionHash: string
    settledAt?: Date
    status?: SettlementStatus
  }): Promise<{ isDuplicate: boolean }> {
    const res = await this.settlementsRepo.upsert(input)
    return { isDuplicate: res.isDuplicate }
  }

  async upsertBatch(inputs: CreateSettlementInput[]): Promise<UpsertSettlementResult[]> {
    return this.settlementsRepo.upsertBatch(inputs)
  }
}

  async claimForPayout(input: {
    bondId: string | number
    amount: string
    transactionHash: string
    settledAt?: Date
    orphanThresholdMs?: number
  }) {
    return this.settlementsRepo.claimForPayout(input)
  }

  async transitionStatus(
    transactionHash: string,
    fromStatus: SettlementStatus,
    toStatus: SettlementStatus,
  ): Promise<boolean> {
    return this.settlementsRepo.transitionStatus(transactionHash, fromStatus, toStatus)
  }
}
