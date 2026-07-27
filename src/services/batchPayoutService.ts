import {
  BatchPayoutProcessor,
  type PayoutItem,
  type BatchPayoutResult,
  type PayoutExecutor,
  type PayoutSettlementStore,
  type BatchPayoutOptions,
} from '../jobs/batchPayoutProcessor.js'

/**
 * Service orchestrating batch payouts with upfront payload validation (atomic semantics)
 * and per-item execution/persistence isolation.
 */
export class BatchPayoutService {
  private readonly processor: BatchPayoutProcessor

  constructor(
    private readonly store: PayoutSettlementStore,
    private readonly executor: PayoutExecutor,
    options: BatchPayoutOptions = {},
  ) {
    this.processor = new BatchPayoutProcessor(store, executor, options)
  }

  /**
   * Processes a batch of payouts, ensuring the entire payload is validated before any writes occur.
   */
  async processBatch(items: PayoutItem[]): Promise<BatchPayoutResult> {
    // The processor's process method already calls validatePayload as its first step,
    // guaranteeing atomic validation semantics before any database writes occur.
    return this.processor.process(items)
  }

  /**
   * Validates a batch payload without processing it.
   */
  validatePayload(items: PayoutItem[]): void {
    this.processor.validatePayload(items)
  }
}
