import { OUTBOX_MAX_LAG_SECONDS } from '../../config/constants.js'
import { OutboxRepository } from '../../db/outbox/repository.js'
import type { Queryable } from '../../db/repositories/queryable.js'
import { logger } from '../../utils/logger.js'

export interface OutboxPublisherLag {
  status: 'up' | 'down'
  lagSeconds: number
}

export async function evaluateOutboxPublisherLag(
  db: Queryable,
  maxLagSeconds: number = OUTBOX_MAX_LAG_SECONDS,
): Promise<OutboxPublisherLag> {
  try {
    const repository = new OutboxRepository()
    const lagSeconds = await repository.getOldestPendingEventLagSeconds(db)
    return {
      status: lagSeconds > maxLagSeconds ? 'down' : 'up',
      lagSeconds,
    }
  } catch (error) {
    logger.error({ message: '[Health] Outbox lag check failed', error })
    return { status: 'down', lagSeconds: 0 }
  }
}
