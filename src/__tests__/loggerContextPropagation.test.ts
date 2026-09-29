import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  logger,
  tracingContext,
  getActiveCorrelationIds,
  runWithCorrelationIds,
  sanitizeCorrelationId,
} from '../utils/logger.js'

describe('req.log context propagation (logger tracing context)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('nested async functions receive the same logger context', async () => {
    const context = new Map<string, string>()
    context.set('requestId', 'req-123')
    context.set('correlationId', 'corr-456')

    await tracingContext.run(context, async () => {
      // First level async function
      const firstLevel = async () => {
        logger.info('first level log')
        await secondLevel()
      }

      // Second level nested async function
      const secondLevel = async () => {
        // Yield to event loop to ensure true async execution
        await new Promise(resolve => setTimeout(resolve, 10))
        logger.info('second level log')
      }

      await firstLevel()
    })

    expect(console.log).toHaveBeenCalledTimes(2)
    const firstCallArgs = JSON.parse((console.log as any).mock.calls[0][0])
    const secondCallArgs = JSON.parse((console.log as any).mock.calls[1][0])

    expect(firstCallArgs.requestId).toBe('req-123')
    expect(firstCallArgs.correlationId).toBe('corr-456')
    expect(firstCallArgs.message).toBe('first level log')

    expect(secondCallArgs.requestId).toBe('req-123')
    expect(secondCallArgs.correlationId).toBe('corr-456')
    expect(secondCallArgs.message).toBe('second level log')
  })

  it('handles empty context gracefully outside of request scope (sad path)', async () => {
    // Outside of tracingContext.run
    const testAsync = async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      logger.info('outside context')
    }
    
    await testAsync()
    
    expect(console.log).toHaveBeenCalledTimes(1)
    const callArgs = JSON.parse((console.log as any).mock.calls[0][0])
    
    expect(callArgs.requestId).toBe('N/A')
    expect(callArgs.correlationId).toBe('N/A')
    expect(callArgs.message).toBe('outside context')
  })
})

describe('correlation id capture and restoration (async job / webhook propagation)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getActiveCorrelationIds', () => {
    it('returns the correlation/request ids from the active tracing context', async () => {
      const context = new Map<string, string>()
      context.set('correlationId', 'corr-abc')
      context.set('requestId', 'req-xyz')

      let captured: ReturnType<typeof getActiveCorrelationIds> | undefined
      await tracingContext.run(context, async () => {
        captured = getActiveCorrelationIds()
      })

      expect(captured).toEqual({ correlationId: 'corr-abc', requestId: 'req-xyz' })
    })

    it('returns undefined values when there is no active context (background/listener code)', () => {
      const captured = getActiveCorrelationIds()
      expect(captured.correlationId).toBeUndefined()
      expect(captured.requestId).toBeUndefined()
    })

    it('treats the placeholder "N/A" value as absent', async () => {
      // A context can exist (e.g. a job scheduler run) without ids ever
      // having been set, in which case downstream reads would see 'N/A'.
      const context = new Map<string, string>()

      let captured: ReturnType<typeof getActiveCorrelationIds> | undefined
      await tracingContext.run(context, async () => {
        captured = getActiveCorrelationIds()
      })

      expect(captured?.correlationId).toBeUndefined()
      expect(captured?.requestId).toBeUndefined()
    })
  })

  describe('runWithCorrelationIds', () => {
    it('installs the given ids so logger calls inside fn are tagged with them', async () => {
      await runWithCorrelationIds({ correlationId: 'corr-restored', requestId: 'req-restored' }, async () => {
        logger.info('restored context log')
      })

      const callArgs = JSON.parse((console.log as any).mock.calls[0][0])
      expect(callArgs.correlationId).toBe('corr-restored')
      expect(callArgs.requestId).toBe('req-restored')
    })

    it('round-trips ids captured from one context into a later, unrelated context', async () => {
      // Simulates: HTTP request emits an event (capture) -> event is
      // persisted -> a background worker later processes it (restore).
      const originatingContext = new Map<string, string>()
      originatingContext.set('correlationId', 'corr-original')

      let captured: ReturnType<typeof getActiveCorrelationIds> | undefined
      await tracingContext.run(originatingContext, async () => {
        captured = getActiveCorrelationIds()
      })

      // Simulate leaving the original request scope entirely before the
      // background job runs.
      await runWithCorrelationIds(captured!, async () => {
        logger.info('background job log')
      })

      const callArgs = JSON.parse((console.log as any).mock.calls[0][0])
      expect(callArgs.correlationId).toBe('corr-original')
    })

    it('omits ids that are undefined rather than writing literal "undefined"', async () => {
      await runWithCorrelationIds({}, async () => {
        logger.info('no ids log')
      })

      const callArgs = JSON.parse((console.log as any).mock.calls[0][0])
      expect(callArgs.correlationId).toBe('N/A')
      expect(callArgs.requestId).toBe('N/A')
    })
  })

  describe('sanitizeCorrelationId', () => {
    it('passes through a well-formed uuid unchanged', () => {
      expect(sanitizeCorrelationId('00000000-0000-4000-8000-000000000000')).toBe(
        '00000000-0000-4000-8000-000000000000'
      )
    })

    it('strips characters that could enable header/log injection', () => {
      // CRLF is the classic header-injection vector; anything not in the
      // safe token set is stripped rather than rejected outright, since
      // this value may have round-tripped through a client-supplied
      // header and we still want a best-effort id for correlation.
      expect(sanitizeCorrelationId('abc\r\nX-Injected: evil')).toBe('abcX-Injected:evil')
    })

    it('truncates excessively long values', () => {
      const long = 'a'.repeat(500)
      expect(sanitizeCorrelationId(long)?.length).toBe(128)
    })

    it('returns undefined for empty/null/undefined input', () => {
      expect(sanitizeCorrelationId('')).toBeUndefined()
      expect(sanitizeCorrelationId(null)).toBeUndefined()
      expect(sanitizeCorrelationId(undefined)).toBeUndefined()
    })
  })
})
