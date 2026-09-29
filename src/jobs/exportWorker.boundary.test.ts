import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportWorker } from './exportWorker.js'
import type { ExportDataSource, ExportRow, ExportWriter } from './exportTypes.js'

/**
 * Boundary and recovery coverage for ExportWorker (#1421).
 *
 * Focuses on the failure/recovery lifecycle (open -> write* -> close | abort)
 * and the batch boundary conditions that the happy-path suite does not pin down.
 */

type MockWriter = ExportWriter & {
  batches: ExportRow[][]
  aborted: boolean
  closed: boolean
  open: ReturnType<typeof vi.fn>
  writeBatch: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
}

function createMockWriter(): MockWriter {
  const state = {
    batches: [] as ExportRow[][],
    aborted: false,
    closed: false,
    open: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    writeBatch: vi.fn<(rows: ExportRow[]) => Promise<void>>(),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    abort: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as MockWriter

  state.writeBatch.mockImplementation(async (rows: ExportRow[]) => {
    state.batches.push([...rows])
  })
  state.close.mockImplementation(async () => {
    state.closed = true
  })
  state.abort.mockImplementation(async () => {
    state.aborted = true
  })

  return state
}

/** A data source that yields the given batches, regardless of the total count. */
function dataSourceFrom(rows: ExportRow[], cursorBatch: number, totalCount?: number): ExportDataSource {
  return {
    getTotalCount: vi.fn<() => Promise<number>>().mockResolvedValue(totalCount ?? rows.length),
    openCursor(): AsyncIterable<ExportRow[]> {
      let offset = 0
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (offset >= rows.length) return { done: true as const, value: undefined }
              const batch = rows.slice(offset, offset + cursorBatch)
              offset += cursorBatch
              return { done: false as const, value: batch }
            },
          }
        },
      }
    },
  }
}

const rows = (n: number): ExportRow[] => Array.from({ length: n }, (_, id) => ({ id }))

describe('ExportWorker — boundary conditions', () => {
  let writer: MockWriter

  beforeEach(() => {
    writer = createMockWriter()
  })

  it('does not request an extra (empty) batch when the row count is an exact multiple of batchSize', async () => {
    const dataSource = dataSourceFrom(rows(4), 2)
    const result = await new ExportWorker(dataSource, writer, { batchSize: 2 }).run()

    expect(result.totalRows).toBe(4)
    expect(result.batchesProcessed).toBe(2)
    expect(writer.writeBatch).toHaveBeenCalledTimes(2)
    expect(writer.batches).toEqual([
      [{ id: 0 }, { id: 1 }],
      [{ id: 2 }, { id: 3 }],
    ])
  })

  it('tails a partial final batch', async () => {
    const result = await new ExportWorker(dataSourceFrom(rows(5), 2), writer, { batchSize: 2 }).run()

    expect(result.totalRows).toBe(5)
    expect(result.batchesProcessed).toBe(3)
    expect(writer.batches.at(-1)).toEqual([{ id: 4 }])
  })

  it('handles a single row with a batchSize larger than the dataset', async () => {
    const result = await new ExportWorker(dataSourceFrom(rows(1), 10), writer, { batchSize: 10 }).run()

    expect(result.totalRows).toBe(1)
    expect(result.batchesProcessed).toBe(1)
    expect(writer.closed).toBe(true)
  })

  it('processes row-by-row when batchSize is 1 (lower boundary)', async () => {
    const result = await new ExportWorker(dataSourceFrom(rows(3), 1), writer, { batchSize: 1 }).run()

    expect(result.batchesProcessed).toBe(3)
    expect(writer.writeBatch).toHaveBeenCalledTimes(3)
  })

  it('still writes rows when getTotalCount disagrees with the cursor (mismatch)', async () => {
    // totalCount reports 0 but the cursor still yields one batch.
    const result = await new ExportWorker(dataSourceFrom(rows(2), 2, 0), writer, { batchSize: 2 }).run()

    expect(result.totalRows).toBe(2)
    expect(result.batchesProcessed).toBe(1)
    expect(writer.closed).toBe(true)
  })

  it('reports zero errors and closes exactly once on success', async () => {
    const result = await new ExportWorker(dataSourceFrom(rows(2), 2), writer, { batchSize: 2 }).run()

    expect(result.errors).toBe(0)
    expect(writer.close).toHaveBeenCalledTimes(1)
    expect(writer.abort).not.toHaveBeenCalled()
  })

  it('is deterministic across repeated runs of identical input', async () => {
    const shapes = await Promise.all(
      [0, 1].map(() => new ExportWorker(dataSourceFrom(rows(5), 2), createMockWriter(), { batchSize: 2 }).run()),
    )

    expect(shapes[0].totalRows).toBe(shapes[1].totalRows)
    expect(shapes[0].batchesProcessed).toBe(shapes[1].batchesProcessed)
    expect(shapes[0].errors).toBe(shapes[1].errors)
  })
})

describe('ExportWorker — recovery paths', () => {
  let writer: MockWriter

  beforeEach(() => {
    writer = createMockWriter()
  })

  it('aborts (and does not close) when writer.close fails after successful writes', async () => {
    writer.close.mockRejectedValueOnce(new Error('close failed'))

    await expect(
      new ExportWorker(dataSourceFrom(rows(2), 2), writer, { batchSize: 2 }).run(),
    ).rejects.toThrow('close failed')

    expect(writer.abort).toHaveBeenCalledTimes(1)
    expect(writer.closed).toBe(false)
  })

  it('keeps already-written batches when a later batch fails', async () => {
    let call = 0
    writer.writeBatch.mockImplementation(async (batch: ExportRow[]) => {
      call += 1
      if (call === 2) throw new Error('disk full')
      writer.batches.push([...batch])
    })

    await expect(
      new ExportWorker(dataSourceFrom(rows(4), 2), writer, { batchSize: 2 }).run(),
    ).rejects.toThrow('disk full')

    // The first batch was written before the failure; nothing is rolled back.
    expect(writer.batches).toEqual([[{ id: 0 }, { id: 1 }]])
    expect(writer.aborted).toBe(true)
    expect(writer.closed).toBe(false)
  })

  it('aborts when the cursor throws after a successful batch', async () => {
    const dataSource: ExportDataSource = {
      getTotalCount: vi.fn<() => Promise<number>>().mockResolvedValue(10),
      openCursor(): AsyncIterable<ExportRow[]> {
        let calls = 0
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                calls++
                if (calls === 1) return { done: false as const, value: [{ id: 0 }] }
                throw new Error('cursor failed mid-stream')
              },
            }
          },
        }
      },
    }

    await expect(new ExportWorker(dataSource, writer, { batchSize: 1 }).run()).rejects.toThrow(
      'cursor failed mid-stream',
    )

    expect(writer.batches).toHaveLength(1)
    expect(writer.aborted).toBe(true)
  })

  it('still rejects when abort itself throws (never silently succeeds)', async () => {
    writer.abort.mockRejectedValueOnce(new Error('abort failed'))
    writer.writeBatch.mockRejectedValueOnce(new Error('write failed'))

    await expect(new ExportWorker(dataSourceFrom(rows(1), 1), writer, { batchSize: 1 }).run()).rejects.toThrow()

    expect(writer.abort).toHaveBeenCalledTimes(1)
    expect(writer.closed).toBe(false)
  })

  it('does not call abort when getTotalCount fails before open', async () => {
    const dataSource: ExportDataSource = {
      getTotalCount: vi.fn<() => Promise<number>>().mockRejectedValue(new Error('count failed')),
      openCursor: vi.fn(),
    }

    await expect(new ExportWorker(dataSource, writer).run()).rejects.toThrow('count failed')

    expect(writer.open).not.toHaveBeenCalled()
    expect(writer.abort).not.toHaveBeenCalled()
  })

  it('does not call abort when open fails (nothing to abort yet)', async () => {
    writer.open.mockRejectedValueOnce(new Error('open failed'))

    await expect(new ExportWorker(dataSourceFrom(rows(1), 1), writer).run()).rejects.toThrow('open failed')

    expect(writer.abort).not.toHaveBeenCalled()
    expect(writer.closed).toBe(false)
  })

  it('logs each failed batch exactly once before surfacing the error', async () => {
    const logs: string[] = []
    writer.writeBatch.mockRejectedValueOnce(new Error('boom'))

    await expect(
      new ExportWorker(dataSourceFrom(rows(1), 1), writer, {
        batchSize: 1,
        logger: (m) => logs.push(m),
      }).run(),
    ).rejects.toThrow('boom')

    expect(logs.filter((l) => l.includes('Batch 1 failed'))).toHaveLength(1)
    expect(logs.some((l) => l.includes('boom'))).toBe(true)
  })
})
