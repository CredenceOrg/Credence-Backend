import { describe, it, expect } from 'vitest'
import { RingBuffer } from './ringBuffer.js'

describe('RingBuffer', () => {
  describe('constructor', () => {
    it('creates a buffer with the given capacity', () => {
      const buf = new RingBuffer<number>(4)
      expect(buf.capacity).toBe(4)
    })

    it('throws RangeError for capacity 0', () => {
      expect(() => new RingBuffer(0)).toThrow(RangeError)
    })

    it('throws RangeError for negative capacity', () => {
      expect(() => new RingBuffer(-1)).toThrow(RangeError)
    })

    it('throws RangeError for non-integer capacity', () => {
      expect(() => new RingBuffer(1.5)).toThrow(RangeError)
    })

    it('accepts capacity of 1', () => {
      const buf = new RingBuffer<string>(1)
      expect(buf.capacity).toBe(1)
    })
  })

  describe('initial state', () => {
    it('is empty', () => {
      const buf = new RingBuffer<number>(4)
      expect(buf.isEmpty).toBe(true)
      expect(buf.isFull).toBe(false)
      expect(buf.size).toBe(0)
    })

    it('pop returns undefined when empty', () => {
      expect(new RingBuffer<number>(4).pop()).toBeUndefined()
    })

    it('peek returns undefined when empty', () => {
      expect(new RingBuffer<number>(4).peek()).toBeUndefined()
    })
  })

  describe('push', () => {
    it('accepts items while below capacity', () => {
      const buf = new RingBuffer<number>(3)
      expect(buf.push(1)).toBe(true)
      expect(buf.push(2)).toBe(true)
      expect(buf.push(3)).toBe(true)
      expect(buf.size).toBe(3)
    })

    it('returns false (backpressure) when full', () => {
      const buf = new RingBuffer<number>(2)
      buf.push(1)
      buf.push(2)
      expect(buf.push(3)).toBe(false)
      expect(buf.size).toBe(2) // unchanged
    })

    it('does not overwrite existing items when full', () => {
      const buf = new RingBuffer<number>(2)
      buf.push(10)
      buf.push(20)
      buf.push(99) // rejected
      expect(buf.pop()).toBe(10)
      expect(buf.pop()).toBe(20)
    })

    it('marks buffer as full at capacity', () => {
      const buf = new RingBuffer<number>(2)
      buf.push(1)
      expect(buf.isFull).toBe(false)
      buf.push(2)
      expect(buf.isFull).toBe(true)
    })
  })

  describe('pop', () => {
    it('dequeues items in FIFO order', () => {
      const buf = new RingBuffer<number>(4)
      buf.push(1)
      buf.push(2)
      buf.push(3)
      expect(buf.pop()).toBe(1)
      expect(buf.pop()).toBe(2)
      expect(buf.pop()).toBe(3)
    })

    it('decrements size', () => {
      const buf = new RingBuffer<number>(4)
      buf.push(1)
      buf.push(2)
      buf.pop()
      expect(buf.size).toBe(1)
    })

    it('marks buffer as empty after all items popped', () => {
      const buf = new RingBuffer<number>(2)
      buf.push(1)
      buf.pop()
      expect(buf.isEmpty).toBe(true)
    })
  })

  describe('peek', () => {
    it('returns the next item without removing it', () => {
      const buf = new RingBuffer<number>(4)
      buf.push(42)
      expect(buf.peek()).toBe(42)
      expect(buf.size).toBe(1)
    })

    it('returns the same item on repeated calls', () => {
      const buf = new RingBuffer<string>(4)
      buf.push('hello')
      expect(buf.peek()).toBe('hello')
      expect(buf.peek()).toBe('hello')
    })
  })

  describe('wrap-around behaviour', () => {
    it('correctly wraps head and tail pointers', () => {
      const buf = new RingBuffer<number>(3)
      buf.push(1)
      buf.push(2)
      buf.push(3)
      buf.pop() // head moves to slot 1
      buf.push(4) // tail wraps to slot 0
      expect(buf.pop()).toBe(2)
      expect(buf.pop()).toBe(3)
      expect(buf.pop()).toBe(4)
      expect(buf.isEmpty).toBe(true)
    })

    it('allows accepting new items after popping from a full buffer', () => {
      const buf = new RingBuffer<number>(2)
      buf.push(1)
      buf.push(2)
      expect(buf.push(3)).toBe(false) // full
      buf.pop()
      expect(buf.push(3)).toBe(true) // slot freed
      expect(buf.pop()).toBe(2)
      expect(buf.pop()).toBe(3)
    })
  })

  describe('clear', () => {
    it('resets size to 0', () => {
      const buf = new RingBuffer<number>(4)
      buf.push(1)
      buf.push(2)
      buf.clear()
      expect(buf.size).toBe(0)
      expect(buf.isEmpty).toBe(true)
    })

    it('allows pushing after clear', () => {
      const buf = new RingBuffer<number>(2)
      buf.push(1)
      buf.push(2)
      buf.clear()
      expect(buf.push(10)).toBe(true)
      expect(buf.pop()).toBe(10)
    })
  })

  describe('generic typing', () => {
    it('works with string items', () => {
      const buf = new RingBuffer<string>(2)
      buf.push('a')
      buf.push('b')
      expect(buf.pop()).toBe('a')
    })

    it('works with object items', () => {
      const buf = new RingBuffer<{ id: number }>(2)
      const obj = { id: 1 }
      buf.push(obj)
      expect(buf.pop()).toBe(obj)
    })

    it('works with function items (job use-case)', () => {
      const buf = new RingBuffer<() => string>(4)
      const job = () => 'done'
      buf.push(job)
      const retrieved = buf.pop()
      expect(retrieved?.()).toBe('done')
    })
  })

  describe('backpressure integration scenario', () => {
    it('producer respects backpressure and consumer drains correctly', () => {
      const capacity = 4
      const buf = new RingBuffer<number>(capacity)
      const dropped: number[] = []

      // Producer sends 6 items into a capacity-4 buffer
      for (let i = 1; i <= 6; i++) {
        if (!buf.push(i)) {
          dropped.push(i)
        }
      }

      expect(dropped).toEqual([5, 6])
      expect(buf.isFull).toBe(true)

      // Consumer drains
      const consumed: number[] = []
      let item: number | undefined
      while ((item = buf.pop()) !== undefined) {
        consumed.push(item)
      }

      expect(consumed).toEqual([1, 2, 3, 4])
      expect(buf.isEmpty).toBe(true)
    })
  })
})
