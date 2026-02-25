import { describe, expect, it } from 'vitest'
import { getRequiredShutdownTimeoutMs } from './server.js'

describe('getRequiredShutdownTimeoutMs', () => {
  it('returns parsed timeout for valid value', () => {
    const timeout = getRequiredShutdownTimeoutMs({
      SHUTDOWN_TIMEOUT_MS: '10000',
    } as NodeJS.ProcessEnv)
    expect(timeout).toBe(10000)
  })

  it('throws when SHUTDOWN_TIMEOUT_MS is missing', () => {
    expect(() =>
      getRequiredShutdownTimeoutMs({} as NodeJS.ProcessEnv)
    ).toThrow('SHUTDOWN_TIMEOUT_MS is required')
  })

  it('throws when SHUTDOWN_TIMEOUT_MS is invalid', () => {
    expect(() =>
      getRequiredShutdownTimeoutMs({
        SHUTDOWN_TIMEOUT_MS: 'abc',
      } as NodeJS.ProcessEnv)
    ).toThrow('SHUTDOWN_TIMEOUT_MS must be a positive integer in milliseconds')
  })
})
