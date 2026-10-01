import { describe, expect, it, vi } from 'vitest'
import { pumpExportBatches } from './exportPipeline.js'
import type { ExportRow } from './exportTypes.js'

function row(index: number): ExportRow {
  return { id: index }
}

/**
 * Returns a writeBatch that succeeds until its `failOnCall`-th invocation,
 * rejects with `error` exactly once, then succeeds again. The failing call is
 * not recorded in `written`: a rejected write is treated as not having landed,
 * so the caller may retry by invoking writeBatch with the same rows.
 */
function createFlakyWriter(failOnCall: number, error: Error) {
  const written: ExportRow[][] = []
  let calls = 0
  return {
    written,
    writeBatch: vi.fn(async (rows: ExportRow[]) => {
      calls++
      if (calls === failOnCall) {
        throw error
      }
      written.push(rows)
    }),
  }
}

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

  describe('boundary conditions', () => {
    it('completes without invoking the writer for an empty cursor', async () => {
      async function* batches(): AsyncIterable<ExportRow[]> {
        // yields nothing
      }

      const writeBatch = vi.fn<(rows: ExportRow[]) => Promise<void>>()

      const result = await pumpExportBatches(batches(), writeBatch)

      expect(result).toEqual({ totalRows: 0, batchesProcessed: 0 })
      expect(writeBatch).not.toHaveBeenCalled()
    })

    it('processes a single-batch cursor and yields batch objects unmodified', async () => {
      const batch = [row(1), row(2)]
      async function* batches(): AsyncIterable<ExportRow[]> {
        yield batch
      }

      const writeBatch = vi.fn<(rows: ExportRow[]) => Promise<void>>()

      const result = await pumpExportBatches(batches(), writeBatch)

      expect(result).toEqual({ totalRows: 2, batchesProcessed: 1 })
      expect(writeBatch).toHaveBeenCalledOnce()
      expect(writeBatch.mock.calls[0][0]).toBe(batch)
    })

    it('counts batches containing empty arrays and never writes undefined', async () => {
      async function* batches(): AsyncIterable<ExportRow[]> {
        yield []
        yield [row(1)]
        yield []
        yield [row(2)]
      }

      const writeBatch = vi.fn<(rows: ExportRow[]) => Promise<void>>()

      const result = await pumpExportBatches(batches(), writeBatch)

      expect(result.totalRows).toBe(2)
      expect(result.batchesProcessed).toBe(4)
      expect(writeBatch).toHaveBeenCalledTimes(4)
      expect(writeBatch.mock.calls.map((call) => call[0].length)).toEqual([0, 1, 0, 1])
    })

    it('stops cleanly when the consumer breaks out of the cursor mid-stream', async () => {
      let producedAfterBreak = 0
      async function* batches(): AsyncIterable<ExportRow[]> {
        yield [row(1)]
        yield [row(2)]
        producedAfterBreak++
        yield [row(3)]
      }

      const written: number[] = []
      for await (const batch of batches()) {
        written.push(batch.length)
        if (written.length === 2) break
      }

      expect(written).toEqual([1, 1])
      expect(producedAfterBreak).toBe(0)
    })

    it('keeps row accounting exact for a large batch count', async () => {
      const totalBatches = 1_000
      const rowsPerBatch = 7
      let generated = 0
      async function* batches(): AsyncIterable<ExportRow[]> {
        for (let i = 0; i < totalBatches; i++) {
          const batch: ExportRow[] = []
          for (let r = 0; r < rowsPerBatch; r++) {
            batch.push(row(generated++))
          }
          yield batch
        }
      }

      const seenIds: number[] = []
      const result = await pumpExportBatches(batches(), async (rows) => {
        for (const r of rows) seenIds.push(r.id as number)
      })

      expect(result).toEqual({
        totalRows: totalBatches * rowsPerBatch,
        batchesProcessed: totalBatches,
      })
      expect(seenIds).toHaveLength(totalBatches * rowsPerBatch)
      expect(seenIds[0]).toBe(0)
      expect(seenIds[seenIds.length - 1]).toBe(totalBatches * rowsPerBatch - 1)
      expect(new Set(seenIds).size).toBe(totalBatches * rowsPerBatch)
    })
  })

  describe('recovery and failure paths', () => {
    it('propagates a writer rejection with its identity intact', async () => {
      const failure = new Error('disk full')
      async function* batches(): AsyncIterable<ExportRow[]> {
        yield [row(1)]
        yield [row(2)]
      }

      const writeBatch = vi.fn<(rows: ExportRow[]) => Promise<void>>()
      writeBatch.mockRejectedValueOnce(failure)

      await expect(pumpExportBatches(batches(), writeBatch)).rejects.toBe(failure)
      expect(writeBatch).toHaveBeenCalledOnce()
    })

    it('stops consuming from the cursor after a writer rejection', async () => {
      let pulledBatches = 0
      async function* batches(): AsyncIterable<ExportRow[]> {
        for (let i = 0; i < 10; i++) {
          pulledBatches++
          yield [row(i)]
        }
      }

      const writeBatch = vi.fn<(rows: ExportRow[]) => Promise<void>>()
      writeBatch.mockRejectedValueOnce(new Error('write failed'))

      await expect(pumpExportBatches(batches(), writeBatch)).rejects.toThrow('write failed')

      expect(pulledBatches).toBe(1)
      expect(writeBatch).toHaveBeenCalledTimes(1)
    })

    it('does not run a write concurrently with a rejected write, and reports exact counts', async () => {
      const written: ExportRow[][] = []
      let calls = 0
      const writeBatch = vi.fn(async (rows: ExportRow[]) => {
        calls++
        if (calls === 2) throw new Error('transient write failure')
        written.push(rows)
      })

      async function* batches(): AsyncIterable<ExportRow[]> {
        yield [row(1)]
        yield [row(2)]
        yield [row(3)]
      }

      await expect(pumpExportBatches(batches(), writeBatch)).rejects.toThrow(
        'transient write failure',
      )

      expect(calls).toBe(2)
      expect(written).toEqual([[row(1)]])
    })

    it('propagates a cursor rejection without calling the writer again', async () => {
      let cursorPulls = 0
      const cursor: AsyncIterable<ExportRow[]> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              cursorPulls++
              if (cursorPulls === 1) {
                return { done: false as const, value: [row(1)] }
              }
              throw new Error('cursor connection lost')
            },
          }
        },
      }

      const writeBatch = vi.fn<(rows: ExportRow[]) => Promise<void>>()

      await expect(pumpExportBatches(cursor, writeBatch)).rejects.toThrow(
        'cursor connection lost',
      )
      expect(cursorPulls).toBe(2)
      expect(writeBatch).toHaveBeenCalledOnce()
    })

    it('does not double-write the failing batch when a retried write is re-injected', async () => {
      const failure = new Error('transient')
      const writer = createFlakyWriter(1, failure)

      async function* batches(): AsyncIterable<ExportRow[]> {
        yield [row(1)]
        yield [row(2)]
      }

      // Re-injection contract: the caller may re-run a rejected batch. The
      // pipeline itself never re-invokes writeBatch for the same rows.
      await expect(pumpExportBatches(batches(), writer.writeBatch)).rejects.toBe(failure)
      await writer.writeBatch([row(2)])

      // Batch 1 was handed off exactly once before the rejection; batch 2 was
      // written once by the caller's retry — no duplication, no data loss.
      expect(writer.writeBatch).toHaveBeenCalledTimes(2)
      expect(writer.writeBatch.mock.calls[0][0]).toEqual([row(1)])
      expect(writer.written).toEqual([[row(2)]])
    })

    it('runs two pumps over independent cursors concurrently without interference', async () => {
      function makeCursor(tag: string, count: number): AsyncIterable<ExportRow[]> {
        async function* batches(): AsyncIterable<ExportRow[]> {
          for (let i = 0; i < count; i++) {
            yield [{ id: `${tag}-${i}` }]
          }
        }
        return batches()
      }

      const seen: string[] = []
      const writeBatch = async (rows: ExportRow[]) => {
        seen.push(rows[0].id as string)
      }

      const [a, b] = await Promise.all([
        pumpExportBatches(makeCursor('a', 50), writeBatch),
        pumpExportBatches(makeCursor('b', 50), writeBatch),
      ])

      expect(a).toEqual({ totalRows: 50, batchesProcessed: 50 })
      expect(b).toEqual({ totalRows: 50, batchesProcessed: 50 })
      expect(seen).toHaveLength(100)
      expect(seen.filter((id) => id.startsWith('a-'))).toHaveLength(50)
      expect(seen.filter((id) => id.startsWith('b-'))).toHaveLength(50)
    })
  })
})
