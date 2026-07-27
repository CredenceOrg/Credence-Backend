import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logger, tracingContext } from '../utils/logger.js'

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
