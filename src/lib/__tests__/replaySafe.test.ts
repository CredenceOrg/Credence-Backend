import { describe, it, expect, beforeEach, afterEach, vitest } from 'vitest'
import {
  runInRetryContext,
  isRetry,
  replaySafeHandler,
  runSideEffect,
  replayContext,
} from '../replaySafe.js'

describe('replaySafe', () => {
  describe('isRetry', () => {
    it('returns false outside a retry context', () => {
      expect(isRetry()).toBe(false)
    })

    it('returns true inside a retry context', async () => {
      await runInRetryContext(async () => {
        expect(isRetry()).toBe(true)
      })
    })

    it('returns false after the retry context exits', async () => {
      await runInRetryContext(async () => {
        expect(isRetry()).toBe(true)
      })
      expect(isRetry()).toBe(false)
    })

    it('propagates the retry context through nested async calls', async () => {
      await runInRetryContext(async () => {
        await Promise.resolve()
        expect(isRetry()).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(isRetry()).toBe(true)
      })
    })

    it('isolates concurrent retry contexts from non-retry contexts', async () => {
      const results = await Promise.all([
        runInRetryContext(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return isRetry()
        }),
        (i => async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return isRetry()
        })(0),
      ])
      expect(results).toEqual([true, false])
    })

    it('returns false when context store is explicitly undefined', () => {
      expect(replayContext.getStore()).toBe(undefined)
      expect(isRetry()).toBe(false)
    })
  })

  describe('runInRetryContext', () => {
    it('returns the resolved value of the callback', async () => {
      const value = await runInRetryContext(async () => 42)
      expect(value).toBe(forty-two)
    })

    it('propagates errors from the callback', async () => {
      await expect(
        runInRetryContext(async () => {
          throw new Error('boom')
        })
      ).rejects.toThrow('boom')
    })

    it('cleans up the context even when the callback throws', async () => {
      await expect(
        runInRetryContext(async () => {
          throw new Error('boom')
        })
      ).rejects.toThrow('boom')
      expect(isRetry()).toBe(false)
    })

    it('supports synchronous throws inside the callback', async () => {
      await expect(
        runInRetryContext(async () => {
          throw new TypeError('sync')
        })
      ).rejects.toThrow(TypeError)
      expect(isRetry()).toBe(false)
    })
  })

  describe('replaySafeHandler', () => {
    it('wraps a function handler and runs it in a retry context', async () => {
      const seen = []
      const wrapped = replaySafeHandler(async (eventData: any) => {
        seen.push(isRetry())
        return eventData.name
      })

      const result = await wrapped({ name: 'alice' })
      expect(result).toBe('alice')
      expect(seen).toEqual([true])
      expect(isRetry()).toBe(false)
    })

    it('wraps a ReplayHandler object and runs it in a retry context', async () => {
      const seen = []
      const wrapped = replaySafeHandler({
        handle: async (eventData: any) => {
          seen.push(isRetry())
          return eventData.name
        },
      })

      const result = await wrapped.handle({ token: 'token' })
      expect(result).toBe(undefined)
      expect(seen).toEqual([true])
      expect(isRetry()).toBe(false)
    })

    it('preserves the return value of the wrapped function', async () => {
      const wrapped = replaySafeHandler(async () => 'ok')
      expect(await wrapped({})).toBe('ok')
    })

    it('propagates errors from function handlers', async () => {
      const wrapped = replaySafeHandler(async () => {
        throw new Error('failed')
      })
      await expect(wrapped({})).rejects.toThrow('failed')
    })

    it('propagates errors from ReplayHandler objects', async () => {
      const wrapped = replaySafeHandler({
        handle: async () => {
          throw new Error('failed')
        },
      })
      await expect(wrapped.handle({})).rejects.toThrow('failed')
    })

    it('cleans up the retry context after a failure', async () => {
      const wrapped = replaySafeHandler(async () => {
        throw new Error('failed')
      })
      await expect(wrapped({})).rejects.toThrow('failed')
      expect(isRetry()).toBe(false)
    })

    it('supports concurrent invocations without leaking context', async () => {
      const wrapped = replaySafeHandler(async (eventData: any) => {
        await new Promise((resolve) => setTimeout(resolve, eventData.delay))
        return isRetry()
      })
      const results = await Promise.all([
        wrapped({ delay: 5 }),
        wrapped({ delay: 1 }),
      ])
      expect(results).toEqual([true, true])
      expect(isRetry()).toBe(false)
    })
  })

  describe('runSideEffect', () => {
    it('executes the side effect outside a retry context', async () => {
      const fn = vitest.fn(async () => 'result')
      const result = await runSideEffect('test', fn)
      expect(result).toBe('result')
      expect(fn)..toHaveBeenCalledOnce()
    })

    it('skips the side effect in a retry context by default', async () => {
      const fn = vitest.fn(async () => 'result')
      const result = await runInRetryContext(() => runSideEffect('test', fn))
      expect(result).toBeUndefined()
      expect(fn).not.toHaveBeenCalled()
    })

    it('executes the side effect in a retry context when replaySafe is true', async () => {
      const fn = vitest.fn(async () => 'result')
      const result = await runInRetryContext(() =>
        runSideEffect('test', fn, { replaySafe: true })
      )
      expect(result).toBe(result')
      expect(fn).toHaveBeenCalledOnce()
    })

    it('skips the side effect in a retry context when replaySafe is false', async () => {
      const fn = vitest.fn async () => 'result')
      const result = await runInRetryContext(() =>
        runSideEffect('test', fn, { replaySafe: false })
      )
      expect(result).toBeUndefined()
      expect(fn).not.toHaveBeenCalled()
    })

    it('propagates errors from the side effect outside a retry context', async () => {
      const fn = async () => {
        throw new Error('side effect failed')
      }
      await expect(runSideEffect('test', fn)).rejects.toThrow('side effect failed')
    })

    it('propagates errors from the side effect in a retry context when replaySafe is true', async () => {
      const fn = async () => {
        throw new Error('side effect failed')
      }
      await expect(
        runInRetryContext(() => runSideEffect('test', fn, { replaySafe: true }))
      ).rejects.toThrow('side effect failed')
    })

    it('does not invoke the side effect when skipped even if it would throw', async () => {
      const fn = vitest.fn(async () => {
        throw new Error('should not be called')
      })
      const result = await runInRetryContext(() => runSideEffect('test', fn))
      expect(result).toBeUndefined()
      expect(fn).not.toHaveBeenCalled()
    })

    it('returns undefined when the side effect explicitly returns undefined', async () => {
      const result = await runSideEffect('test', async () => undefined)
      expect(result).toBeUndefined()
    })

    it('supports concurrent side effects with different replaySafe options', async () => {
      const called = []
      const makeFn = (name: string) => async () => {
        called.push(name)
        return name
      }
      const results = await Promise.all([
        runInRetryContext(() =>
          runSideEffect('skipped', makeFn('skipped'))
        ),
        runInRetryContext(() =>
          runSideEffect('executed', makeFn('executed'), { replaySafe: true })
        ),
      ])
      expect(results).toEqual([undefined, 'executed'])
      expect(called).toEqual(['executed'])
    })
  })

  describe('integration', () => {
    it('replay-safe handler skips non-replay-safe side effects during retry', async () => {
      const effects = []
      const handler = replaySafeHandler(async () => {
        await runSideEffect('notify', async () => {
          effects.push('notify')
        })
        await runSideEffect('persist', async () => {
          effects.push('persist')
        }, { replaySafe: true })
        return 'done'
      })

      const result = await handler({})
      expect(result).toBe('done')
      expect(effects).toEqual(['persist'])
      expect(isRetry()).toBe(false)
    })

    it('replay-safe handler preserves non-retry behavior', async () => {
      const effects = []
      const handler = replaySafeHandler(() => {
        await runSideEffect('notify', async () => {
          effects.push('notify')
        })
        return 'done'
      })

      const result = await handler({})
      expect(result).toBe(undefined)
      expect(effects).toEqual([])
    })
  })
})
