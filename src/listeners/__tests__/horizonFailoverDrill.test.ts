// src/listeners/__tests__/horizonFailoverDrill.test.ts
//
// Smoke test for the scripted failover drill.  Importing the script's
// exported `runHorizonFailoverDrill` ensures that:
//   1. The drill runs to completion without throwing.
//   2. All assertions inside the drill pass (it calls process.exit(1) on
//      failure — we intercept that).
//
import { describe, it, expect, vi } from 'vitest'
import {
  runHorizonFailoverDrill,
  type HorizonFailoverDrillCheck,
} from '../../../scripts/horizon-failover-drill.js'
import { createInMemoryLeaseStore } from '../../../scripts/horizon-failover-drill.store.js'

function createClock() {
  let current = Date.now()
  return {
    now: () => new Date(current),
    wait: async (ms: number) => {
      current += ms
    },
  }
}

describe('horizon-failover-drill', () => {
  it('covers the expiry boundary and recovers a skipped event by replay', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      // Throw so the test fails loudly if the drill tries to exit non-zero.
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) called`)
      }) as never)

    // Silence drill console output during the test run.
    const log  = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err  = vi.spyOn(console, 'error').mockImplementation(() => {})
    const checks: HorizonFailoverDrillCheck[] = []
    const clock = createClock()

    try {
      await expect(
        runHorizonFailoverDrill({
          ...clock,
          store: createInMemoryLeaseStore(),
          onCheck: (check) => checks.push(check),
        }),
      ).resolves.toBeUndefined()

      expect(checks.every((check) => check.ok)).toBe(true)
      expect(checks.map((check) => check.name)).toContain(
        'standby remains blocked immediately before expiry',
      )
      expect(checks.map((check) => check.name)).toContain(
        'standby steals lease at the expiry boundary',
      )
      expect(checks.map((check) => check.name)).toContain(
        'lease expired during event handling',
      )
      expect(checks.map((check) => check.name)).toContain(
        'skipped event does not advance the cursor',
      )
      expect(checks.map((check) => check.name)).toContain(
        'in-flight replay: new owner re-processes event 50',
      )
    } finally {
      exit.mockRestore()
      log.mockRestore()
      err.mockRestore()
    }
  })

  it('keeps results isolated across repeated runs', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`)
    }) as never)
    const summaries: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith('Drill complete')) {
        summaries.push(args[0])
      }
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const runs: HorizonFailoverDrillCheck[][] = []
      for (let index = 0; index < 2; index++) {
        const checks: HorizonFailoverDrillCheck[] = []
        await runHorizonFailoverDrill({
          ...createClock(),
          store: createInMemoryLeaseStore(),
          onCheck: (check) => checks.push(check),
        })
        runs.push(checks)
      }

      expect(runs[0]).toHaveLength(runs[1].length)
      expect(runs[0].every((check) => check.ok)).toBe(true)
      expect(runs[1].every((check) => check.ok)).toBe(true)
      expect(summaries).toHaveLength(2)
      expect(summaries[0]).toBe(summaries[1])
    } finally {
      exit.mockRestore()
      log.mockRestore()
      err.mockRestore()
    }
  })
})
