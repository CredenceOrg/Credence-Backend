import { describe, it, expect } from 'vitest'
import type {
  CreateIdempotencyInput,
  IdempotencyRecord,
} from '../db/repositories/idempotencyRepository.js'
import type { IdempotentResult } from './idempotentConsumer.js'

class Deferred<T> {
  promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void
  reject!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

/**
 * Minimal controllable repository harness for asserting exactly-once handling
 * under concurrent redelivery. It keeps successful results, drops failures, and
 * exposes an in-flight map so duplicate callers can join the same execution.
 */
class InMemoryIdempotencyRepository {
  private readonly records = new Map<string, IdempotencyRecord>()
  private readonly inflight = new Map<string, Promise<IdempotentResult<unknown>>>()

  async findByKey(key: string): Promise<IdempotencyRecord | null> {
    const record = this.records.get(key)
    if (!record) {
      return null
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      this.records.delete(key)
      return null
    }

    return record
  }

  async save(input: CreateIdempotencyInput): Promise<void> {
    const ttlSeconds = input.expiresInSeconds ?? input.ttlSeconds
    const now = new Date()

    if (input.responseCode >= 400) {
      this.records.delete(input.key)
      return
    }

    this.records.set(input.key, {
      key: input.key,
      actorId: input.actorId,
      requestHash: input.requestHash,
      responseCode: input.responseCode,
      responseBody: input.responseBody,
      ttlSeconds: input.ttlSeconds,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      createdAt: now,
    })
  }

  getInflight(key: string): Promise<IdempotentResult<unknown>> | null {
    return this.inflight.get(key) ?? null
  }

  setInflight(key: string, promise: Promise<IdempotentResult<unknown>>): void {
    this.inflight.set(key, promise)
  }

  clearInflight(key: string): void {
    this.inflight.delete(key)
  }
}

interface ProcessOptions {
  actorId?: string
  ttlSeconds?: number
}

/**
 * Test-only processor that models the intended exactly-once semantics for an
 * at-least-once consumer: duplicates with the same message id share one active
 * handler execution, successful results are cached, and failed executions are
 * not marked processed so redelivery retries can run.
 */
async function processIdempotently<R>(
  repository: InMemoryIdempotencyRepository,
  messageId: string,
  handler: () => Promise<R>,
  options: ProcessOptions = {}
): Promise<IdempotentResult<R>> {
  const existing = await repository.findByKey(messageId)
  if (existing) {
    return {
      success: existing.responseCode < 400,
      result: existing.responseBody as R,
      processedAt: existing.createdAt,
    }
  }

  const active = repository.getInflight(messageId)
  if (active) {
    return active as Promise<IdempotentResult<R>>
  }

  const execution = (async () => {
    try {
      const result = await handler()
      const processedAt = new Date()

      await repository.save({
        key: messageId,
        actorId: options.actorId ?? 'system',
        requestHash: messageId,
        responseCode: 200,
        responseBody: result,
        ttlSeconds: options.ttlSeconds ?? 86400,
      })

      return {
        success: true,
        result,
        processedAt,
      } satisfies IdempotentResult<R>
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: errorMessage,
        processedAt: new Date(),
      } satisfies IdempotentResult<R>
    } finally {
      repository.clearInflight(messageId)
    }
  })()

  repository.setInflight(messageId, execution as Promise<IdempotentResult<unknown>>)
  return execution
}

function createConcurrentInvocations<R>(
  count: number,
  invoke: () => Promise<IdempotentResult<R>>
): Promise<IdempotentResult<R>>[] {
  return Array.from({ length: count }, () => invoke())
}

describe('idempotent consumer concurrency scenarios', () => {
  it('fires N concurrent invocations for the same id and runs the handler exactly once', async () => {
    const repository = new InMemoryIdempotencyRepository()
    const deferred = new Deferred<{ ok: true; messageId: string }>()
    let handlerCalls = 0

    const handler = async () => {
      handlerCalls += 1
      return deferred.promise
    }

    const invocations = createConcurrentInvocations(32, () =>
      processIdempotently(repository, 'message-1', handler)
    )

    await Promise.resolve()
    await Promise.resolve()

    expect(handlerCalls).toBe(1)

    deferred.resolve({ ok: true, messageId: 'message-1' })
    const results = await Promise.all(invocations)

    expect(handlerCalls).toBe(1)
    expect(results.every((result) => result.success)).toBe(true)
    expect(results.every((result) => result.result?.messageId === 'message-1')).toBe(true)
    expect(results.every((result) => result.processedAt.getTime() === results[0]?.processedAt.getTime())).toBe(true)
  })

  it('runs distinct message ids independently while deduping concurrent redelivery per id', async () => {
    const repository = new InMemoryIdempotencyRepository()
    const first = new Deferred<{ ok: true; messageId: string }>()
    const second = new Deferred<{ ok: true; messageId: string }>()
    let firstCalls = 0
    let secondCalls = 0

    const sameIdCalls = createConcurrentInvocations(8, () =>
      processIdempotently(repository, 'message-1', async () => {
        firstCalls += 1
        return first.promise
      })
    )

    const otherIdCalls = createConcurrentInvocations(8, () =>
      processIdempotently(repository, 'message-2', async () => {
        secondCalls += 1
        return second.promise
      })
    )

    await Promise.resolve()
    await Promise.resolve()

    expect(firstCalls).toBe(1)
    expect(secondCalls).toBe(1)

    second.resolve({ ok: true, messageId: 'message-2' })
    first.resolve({ ok: true, messageId: 'message-1' })

    const [firstResults, secondResults] = await Promise.all([
      Promise.all(sameIdCalls),
      Promise.all(otherIdCalls),
    ])

    expect(firstResults.every((result) => result.result?.messageId === 'message-1')).toBe(true)
    expect(secondResults.every((result) => result.result?.messageId === 'message-2')).toBe(true)
    expect(firstResults[0]).toEqual(firstResults.at(-1))
    expect(secondResults[0]).toEqual(secondResults.at(-1))
  })

  it('does not mark failures as processed, so redelivery retries, while a later success is cached', async () => {
    const repository = new InMemoryIdempotencyRepository()
    const failed = new Deferred<{ ok: true; messageId: string }>()
    let handlerCalls = 0

    const failedInvocations = createConcurrentInvocations(12, () =>
      processIdempotently(repository, 'message-3', async () => {
        handlerCalls += 1
        return failed.promise
      })
    )

    await Promise.resolve()
    await Promise.resolve()

    expect(handlerCalls).toBe(1)

    failed.reject(new Error('boom'))
    const failureResults = await Promise.all(failedInvocations)

    expect(failureResults.every((result) => result.success === false)).toBe(true)
    expect(failureResults.every((result) => result.error === 'boom')).toBe(true)
    expect(await repository.findByKey('message-3')).toBeNull()

    const success = await processIdempotently(repository, 'message-3', async () => {
      handlerCalls += 1
      return { ok: true, messageId: 'message-3' }
    })

    const redelivery = await processIdempotently(repository, 'message-3', async () => {
      handlerCalls += 1
      return { ok: true, messageId: 'message-3' }
    })

    expect(handlerCalls).toBe(2)
    expect(success.success).toBe(true)
    expect(redelivery).toEqual(success)
  })
})
