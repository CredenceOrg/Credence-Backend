import type { PoolClient } from 'pg'
import type { Queryable } from '../repositories/queryable.js'
import type { TransactionOptions } from '../transaction.js'
import type { CreateOutboxEvent } from './types.js'

export interface OutboxTransactionRunner {
  withTransaction<T>(callback: (client: PoolClient) => Promise<T>, options?: TransactionOptions): Promise<T>
}

export interface OutboxBatchEmitter {
  emitBatch(db: Queryable, events: CreateOutboxEvent[]): Promise<bigint[]>
}

export type AtomicMutation<T> = (db: PoolClient) => Promise<T>
export type AtomicEvents<T> = (value: T) => CreateOutboxEvent[] | Promise<CreateOutboxEvent[]>

export interface AtomicOutboxOptions extends TransactionOptions {
  operation?: string
  /** A silent mutation must be explicit because it has no integration record. */
  allowEmptyEvents?: boolean
}

export interface AtomicOutboxResult<T> {
  value: T
  eventIds: bigint[]
}

/**
 * Coordinates a business mutation and its outbox rows in one transaction.
 * Both callbacks receive the exact PoolClient owned by TransactionManager.
 * Publishing is deliberately outside this class: workers only see rows after
 * PostgreSQL commits the transaction.
 */
export class AtomicOutboxCoordinator {
  constructor(
    private readonly transactions: OutboxTransactionRunner,
    private readonly emitter: OutboxBatchEmitter
  ) {}

  async run<T>(mutation: AtomicMutation<T>, events: AtomicEvents<T>, options: AtomicOutboxOptions = {}): Promise<AtomicOutboxResult<T>> {
    let resultValue!: T
    let eventIds: bigint[] = []

    await this.transactions.withTransaction(async client => {
      resultValue = await mutation(client)
      const records = await events(resultValue)
      if (records.length === 0 && !options.allowEmptyEvents) {
        throw new Error('Atomic outbox mutation must produce at least one event')
      }
      records.forEach(validateOutboxEvent)

      // Atomicity boundary: emitBatch uses the transaction client, never pool.
      eventIds = await this.emitter.emitBatch(client, records)
      if (eventIds.length !== records.length) {
        throw new Error('Outbox emitter returned an incomplete event id list')
      }
      return resultValue
    }, { ...options, op: options.operation ?? options.op ?? 'atomic_outbox_mutation' })

    return { value: resultValue, eventIds }
  }

  async runOne<T>(mutation: AtomicMutation<T>, event: CreateOutboxEvent | ((value: T) => CreateOutboxEvent), options: AtomicOutboxOptions = {}): Promise<AtomicOutboxResult<T>> {
    return this.run(mutation, value => [typeof event === 'function' ? event(value) : event], options)
  }
}

function validateOutboxEvent(event: CreateOutboxEvent): void {
  if (!event || typeof event !== 'object') throw new Error('Outbox event must be an object')
  if (!event.aggregateType?.trim()) throw new Error('Outbox event aggregateType is required')
  if (!event.aggregateId?.trim()) throw new Error('Outbox event aggregateId is required')
  if (!event.eventType?.trim()) throw new Error('Outbox event eventType is required')
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new Error('Outbox event payload must be a plain object')
  }
}

export function assertOutboxTransactionClient(received: Queryable, transactionClient: Queryable): void {
  if (received !== transactionClient) {
    throw new Error('Business mutation and outbox insertion must share the transaction client')
  }
}
