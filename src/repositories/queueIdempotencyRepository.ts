import type { Queryable } from '../db/repositories/queryable.js'
import {
  IdempotencyRepository,
  type IdempotencyRecord,
  type CreateIdempotencyInput,
} from '../db/repositories/idempotencyRepository.js'

export class QueueIdempotencyRepository extends IdempotencyRepository {
  constructor(db: Queryable) {
    super(db)
  }

  /**
   * Record a successfully processed queue message at the write layer with unique key upsert.
   */
  async recordSuccess(
    messageId: string,
    result: unknown,
    actorId = 'system',
    ttlSeconds = 86400
  ): Promise<void> {
    await this.save({
      key: messageId,
      actorId,
      requestHash: messageId,
      responseCode: 200,
      responseBody: result,
      ttlSeconds,
    })
  }

  /**
   * Clear an idempotency key if processing failed or needs manual reset.
   */
  async clearKey(messageId: string): Promise<void> {
    await this.delete(messageId)
  }
}

export type { IdempotencyRecord, CreateIdempotencyInput }
