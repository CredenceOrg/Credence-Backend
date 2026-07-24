// src/listeners/__tests__/horizonFailoverDrill.test.ts
//
// Smoke test for the scripted failover drill.  Importing the script's
// exported `runHorizonFailoverDrill` ensures that:
//   1. The drill runs to completion without throwing.
//   2. All assertions inside the drill pass (it calls process.exit(1) on
//      failure — we intercept that).
//
import { describe, it, expect, vi } from 'vitest'
import { runHorizonFailoverDrill } from '../../../scripts/horizon-failover-drill.js'

describe('horizon-failover-drill', () => {
  it('completes successfully with all checks passing', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      // Throw so the test fails loudly if the drill tries to exit non-zero.
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) called`)
      }) as never)

    // Silence drill console output during the test run.
    const log  = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err  = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(runHorizonFailoverDrill()).resolves.toBeUndefined()
    } finally {
      exit.mockRestore()
      log.mockRestore()
      err.mockRestore()
    }
  }, 15_000)
})
