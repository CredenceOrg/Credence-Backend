import type { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'

export interface IdempotentMessage<T = unknown> {
  messageId: string
  payload: T
  processedAt?: Date
}

export interface IdempotentResult<T = unknown> {
  success: boolean
  result?: T
  error?: string
  processedAt: Date
}

export interface IdempotentConsumerOptions {
  expiresInSeconds?: number
  /**
   * Actor attributed to idempotency records. Message consumers run outside a
   * user request, so this defaults to a system sentinel.
   */
  actorId?: string
}

export class IdempotentConsumer<T = unknown, R = unknown> {
  private readonly repository: IdempotencyRepository
  private readonly ttlSeconds: number
  private readonly actorId: string
  private readonly inflight = new Map<string, Promise<IdempotentResult<R>>>()

  constructor(
    private readonly db: IdempotencyRepository,
    private readonly options: IdempotentConsumerOptions = {}
  ) {
    this.repository = db
    this.options = {
      expiresInSeconds: 86400,
      ...options,
    }
    this.ttlSeconds = this.options.expiresInSeconds ?? 86400
    this.actorId = this.options.actorId ?? 'system'
  }

  async process(
    messageId: string,
    handler: () => Promise<R>
  ): Promise<IdempotentResult<R>> {
    const existing = await this.repository.findByKey(messageId)

    if (existing && existing.responseCode < 400) {
      return {
        success: true,
        result: existing.responseBody as R,
        processedAt: existing.createdAt,
      }
    }

    const active = this.inflight.get(messageId)
    if (active) {
      return active
    }

    const execution = (async (): Promise<IdempotentResult<R>> => {
      try {
        const result = await handler()
        const processedAt = new Date()

        await this.repository.save({
          key: messageId,
          actorId: this.actorId,
          requestHash: messageId,
          responseCode: 200,
          responseBody: result,
          ttlSeconds: this.ttlSeconds,
        })

        return {
          success: true,
          result,
          processedAt,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        await this.repository.delete(messageId).catch(() => {})

        return {
          success: false,
          error: errorMessage,
          processedAt: new Date(),
        }
      } finally {
        this.inflight.delete(messageId)
      }
    })()

    this.inflight.set(messageId, execution)
    return execution
  }

  async isProcessed(messageId: string): Promise<boolean> {
    const record = await this.repository.findByKey(messageId)
    return record !== null && record.responseCode < 400
  }

  async getResult(messageId: string): Promise<IdempotentResult<R> | null> {
    const record = await this.repository.findByKey(messageId)
    if (!record || record.responseCode >= 400) return null

    return {
      success: true,
      result: record.responseBody as R,
      processedAt: record.createdAt,
    }
  }
}

export function createIdempotentConsumer<T, R>(
  db: IdempotencyRepository,
  options?: IdempotentConsumerOptions
): IdempotentConsumer<T, R> {
  return new IdempotentConsumer(db, options)
}