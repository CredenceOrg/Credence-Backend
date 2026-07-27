import { describe, expect, it, vi } from 'vitest'
import { pumpExportBatches } from './exportPipeline.js'
import type { ExportRow } from './exportTypes.js'

describe('pumpExportBatches', () => {
  it('pulls the next batch only after the previous write completes', async () => {
    let inFlight = 0
    let maxInFlight = 0

    async function* batches(): AsyncIterable<ExportRow[]> {
      for (let i = 0; i < 5; i++) {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        yield [{ id: i }]
        inFlight--
      }
    }

    const writeBatch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })

    const result = await pumpExportBatches(batches(), writeBatch)

    expect(result.totalRows).toBe(5)
    expect(result.batchesProcessed).toBe(5)
    expect(maxInFlight).toBe(1)
    expect(writeBatch).toHaveBeenCalledTimes(5)
  })
})
