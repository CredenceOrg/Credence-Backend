import { describe, it, expect, vi } from 'vitest'
import {
  replaySafeHandler,
  runSideEffect,
  isRetry,
  runInRetryContext,
} from './replaySafe.js'

describe('Replay-Safe mechanism', () => {
  it('should identify retry context correctly', async () => {
    expect(isRetry()).toBe(false)

    const result = await runInRetryContext(async () => {
      expect(isRetry()).toBe(true)
      return 42
    })

    expect(result).toBe(42)
    expect(isRetry()).toBe(false)
  })

  describe('runSideEffect', () => {
    it('runs all side-effects on first attempt (non-retry context)', async () => {
      const effect1 = vi.fn().mockResolvedValue('value-1')
      const effect2 = vi.fn().mockResolvedValue('value-2')

      const res1 = await runSideEffect('non-replay-safe', effect1, { replaySafe: false })
      const res2 = await runSideEffect('replay-safe', effect2, { replaySafe: true })

      expect(effect1).toHaveBeenCalledTimes(1)
      expect(effect2).toHaveBeenCalledTimes(1)
      expect(res1).toBe('value-1')
      expect(res2).toBe('value-2')
    })

    it('only runs replay-safe side-effects on retry', async () => {
      const effect1 = vi.fn().mockResolvedValue('value-1')
      const effect2 = vi.fn().mockResolvedValue('value-2')

      await runInRetryContext(async () => {
        const res1 = await runSideEffect('non-replay-safe', effect1, { replaySafe: false })
        const res2 = await runSideEffect('replay-safe', effect2, { replaySafe: true })

        expect(effect1).not.toHaveBeenCalled()
        expect(effect2).toHaveBeenCalledTimes(1)
        expect(res1).toBeUndefined()
        expect(res2).toBe('value-2')
      })
    })

    it('defaults replaySafe to false if not specified', async () => {
      const effect = vi.fn().mockResolvedValue('value')

      await runInRetryContext(async () => {
        const res = await runSideEffect('default-non-safe', effect)
        expect(effect).not.toHaveBeenCalled()
        expect(res).toBeUndefined()
      })
    })
  })

  describe('replaySafeHandler wrapper', () => {
    it('wraps handler functions to execute in retry context', async () => {
      const handlerFn = vi.fn(async (eventData) => {
        expect(isRetry()).toBe(true)
        return `processed ${eventData}`
      })

      const wrapped = replaySafeHandler(handlerFn)
      const res = await wrapped('event-123')

      expect(handlerFn).toHaveBeenCalledWith('event-123')
      expect(res).toBe('processed event-123')
      expect(isRetry()).toBe(false)
    })

    it('wraps ReplayHandler objects to execute in retry context', async () => {
      const handlerObj = {
        handle: vi.fn(async (eventData) => {
          expect(isRetry()).toBe(true)
        }),
      }

      const wrapped = replaySafeHandler(handlerObj)
      await wrapped.handle('event-456')

      expect(handlerObj.handle).toHaveBeenCalledWith('event-456')
      expect(isRetry()).toBe(false)
    })
  })
})
