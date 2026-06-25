/**
 * A fixed-capacity ring buffer (circular buffer) for job scheduling with backpressure.
 *
 * When the buffer is full, `push` returns `false` (backpressure signal) instead of
 * overwriting existing items or throwing. Consumers call `pop` to dequeue items in
 * FIFO order. Both operations are O(1).
 *
 * @example
 * ```typescript
 * const buf = new RingBuffer<() => Promise<void>>(8)
 *
 * // Producer
 * const accepted = buf.push(job)
 * if (!accepted) {
 *   // backpressure – shed or reschedule the job
 * }
 *
 * // Consumer
 * const job = buf.pop()
 * if (job) await job()
 * ```
 */
export class RingBuffer<T> {
  private readonly buffer: (T | undefined)[]
  private head = 0
  private tail = 0
  private _size = 0

  /** @param capacity Maximum number of items the buffer can hold (must be ≥ 1). */
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`)
    }
    this.buffer = new Array(capacity)
  }

  /**
   * Enqueue an item.
   *
   * @returns `true` if the item was accepted, `false` if the buffer is full
   *          (backpressure signal – the item is **not** added).
   */
  push(item: T): boolean {
    if (this._size === this.capacity) {
      return false // backpressure
    }
    this.buffer[this.tail] = item
    this.tail = (this.tail + 1) % this.capacity
    this._size++
    return true
  }

  /**
   * Dequeue the oldest item.
   *
   * @returns The item, or `undefined` if the buffer is empty.
   */
  pop(): T | undefined {
    if (this._size === 0) {
      return undefined
    }
    const item = this.buffer[this.head] as T
    this.buffer[this.head] = undefined // release reference
    this.head = (this.head + 1) % this.capacity
    this._size--
    return item
  }

  /** Peek at the next item to be dequeued without removing it. */
  peek(): T | undefined {
    return this._size > 0 ? (this.buffer[this.head] as T) : undefined
  }

  /** Number of items currently in the buffer. */
  get size(): number {
    return this._size
  }

  /** `true` when size === 0. */
  get isEmpty(): boolean {
    return this._size === 0
  }

  /** `true` when size === capacity. */
  get isFull(): boolean {
    return this._size === this.capacity
  }

  /** Remove all items from the buffer. */
  clear(): void {
    this.buffer.fill(undefined)
    this.head = 0
    this.tail = 0
    this._size = 0
  }
}
