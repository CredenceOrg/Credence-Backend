import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SingleFlight } from './singleflight'

describe('SingleFlight', () => {
  let sf: SingleFlight

  beforeEach(() => {
    sf = new SingleFlight()
  })

  it('should run a single operation successfully', async () => {
    const fn = vi.fn().mockResolvedValue('success')
    const result = await sf.do('key1', fn)
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sf.size).toBe(0)
    expect(sf.has('key1')).toBe(false)
  })

  it('should coalesce concurrent calls for the same key', async () => {
    let resolvePromise: (value: string) => void
    const promise = new Promise<string>((resolve) => {
      resolvePromise = resolve
    })
    const fn = vi.fn().mockReturnValue(promise)

    // Fire 3 concurrent calls
    const p1 = sf.do('key2', fn)
    const p2 = sf.do('key2', fn)
    const p3 = sf.do('key2', fn)

    expect(sf.size).toBe(1)
    expect(sf.has('key2')).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1) // Only one execution

    resolvePromise!('done')
    const results = await Promise.all([p1, p2, p3])

    expect(results).toEqual(['done', 'done', 'done'])
    expect(sf.size).toBe(0)
  })

  it('should propagate errors to all coalesced callers', async () => {
    let rejectPromise: (reason: Error) => void
    const promise = new Promise<string>((_, reject) => {
      rejectPromise = reject
    })
    const fn = vi.fn().mockReturnValue(promise)

    const p1 = sf.do('key3', fn)
    const p2 = sf.do('key3', fn)

    const error = new Error('failed')
    rejectPromise!(error)

    await expect(p1).rejects.toThrow('failed')
    await expect(p2).rejects.toThrow('failed')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sf.size).toBe(0)
  })

  it('should not coalesce calls for different keys', async () => {
    let resolve1: (val: string) => void
    const p1 = new Promise<string>(r => { resolve1 = r })
    const fn1 = vi.fn().mockReturnValue(p1)

    let resolve2: (val: string) => void
    const p2 = new Promise<string>(r => { resolve2 = r })
    const fn2 = vi.fn().mockReturnValue(p2)

    const req1 = sf.do('keyA', fn1)
    const req2 = sf.do('keyB', fn2)

    expect(sf.size).toBe(2)
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)

    resolve1!('A')
    resolve2!('B')

    expect(await req1).toBe('A')
    expect(await req2).toBe('B')
  })

  it('should allow fresh calls after a success', async () => {
    const fn1 = vi.fn().mockResolvedValue('first')
    await sf.do('key4', fn1)

    const fn2 = vi.fn().mockResolvedValue('second')
    const result = await sf.do('key4', fn2)

    expect(result).toBe('second')
    expect(fn2).toHaveBeenCalledTimes(1)
  })

  it('should allow fresh calls after a failure', async () => {
    const fn1 = vi.fn().mockRejectedValue(new Error('error1'))
    await expect(sf.do('key5', fn1)).rejects.toThrow('error1')

    const fn2 = vi.fn().mockResolvedValue('recovered')
    const result = await sf.do('key5', fn2)

    expect(result).toBe('recovered')
    expect(fn2).toHaveBeenCalledTimes(1)
  })

  it('should handle large number of coalesced calls gracefully', async () => {
    let resolvePromise: (value: number) => void
    const promise = new Promise<number>((resolve) => {
      resolvePromise = resolve
    })
    const fn = vi.fn().mockReturnValue(promise)

    const NUM_CALLS = 1000
    const promises = []
    for (let i = 0; i < NUM_CALLS; i++) {
      promises.push(sf.do('massive-key', fn))
    }

    expect(sf.size).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)

    resolvePromise!(42)
    const results = await Promise.all(promises)

    expect(results).toHaveLength(NUM_CALLS)
    expect(results.every(r => r === 42)).toBe(true)
  })
})
