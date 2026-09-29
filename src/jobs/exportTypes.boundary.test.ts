/**
 * Boundary and recovery test coverage for export types and implementations.
 *
 * This suite validates deterministic behaviour under:
 * - Valid, invalid, duplicate, and boundary-case inputs
 * - Authorization and state-transition invariants
 * - Partial failure, retry, and concurrent execution
 * - Data integrity and consistency guarantees
 *
 * Related: Issue #1420
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ExportDataSource,
  ExportRow,
  ExportWriter,
} from './exportTypes.js'
import { ExportWorker } from './exportWorker.js'
import { pumpExportBatches } from './exportPipeline.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A stateful ExportWriter whose counters and flags are properties on the
 * returned object itself (not a separate closure object), so assertions like
 * `writer.openCount` see the live value after method calls.
 *
 * Pass `methodOverrides` to replace individual methods while still tracking
 * the shared state (open/closed/aborted flags are set in the default impls
 * and also read by other default impls).
 */
function createTestWriter(methodOverrides?: {
  open?: () => Promise<void>
  writeBatch?: (rows: ExportRow[]) => Promise<void>
  close?: () => Promise<void>
  abort?: () => Promise<void>
}): ExportWriter & {
  batches: ExportRow[][]
  openCount: number
  closeCount: number
  abortCount: number
  writeCount: number
  isOpen: boolean
  isAborted: boolean
  isClosed: boolean
} {
  const w = {
    batches: [] as ExportRow[][],
    openCount: 0,
    closeCount: 0,
    abortCount: 0,
    writeCount: 0,
    isOpen: false,
    isAborted: false,
    isClosed: false,

    async open() {
      if (w.isOpen) throw new Error('Writer already open')
      if (w.isAborted || w.isClosed) throw new Error('Writer cannot be reopened after close/abort')
      w.openCount++
      w.isOpen = true
    },
    async writeBatch(rows: ExportRow[]) {
      if (w.isAborted) throw new Error('Cannot write to aborted writer')
      if (!w.isOpen) throw new Error('Cannot write to unopened writer')
      w.writeCount++
      w.batches.push([...rows])
    },
    async close() {
      if (w.isAborted) throw new Error('Cannot close aborted writer')
      if (!w.isOpen) throw new Error('Cannot close unopened writer')
      w.closeCount++
      w.isOpen = false
      w.isClosed = true
    },
    async abort() {
      w.abortCount++
      w.isOpen = false
      w.isAborted = true
    },
  }

  if (methodOverrides?.open) w.open = methodOverrides.open
  if (methodOverrides?.writeBatch) w.writeBatch = methodOverrides.writeBatch
  if (methodOverrides?.close) w.close = methodOverrides.close
  if (methodOverrides?.abort) w.abort = methodOverrides.abort

  return w
}

/**
 * Simple data source backed by an in-memory array.
 * `cursorBatchSize` overrides the requested batch size for cursor emission.
 */
function createTestDataSource(
  rows: ExportRow[],
  overrides?: Partial<ExportDataSource>,
): ExportDataSource {
  return {
    getTotalCount: vi.fn(async () => rows.length),
    openCursor(batchSize: number): AsyncIterable<ExportRow[]> {
      let offset = 0
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (offset >= rows.length) return { done: true as const, value: undefined }
              const batch = rows.slice(offset, offset + batchSize)
              offset += batchSize
              return { done: false as const, value: batch }
            },
          }
        },
      }
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exportTypes - Boundary and Recovery Tests', () => {
  // -------------------------------------------------------------------------
  describe('Boundary Cases', () => {
    // -----------------------------------------------------------------------
    describe('Empty Dataset', () => {
      it('completes successfully with zero rows', async () => {
        const writer = createTestWriter()
        const dataSource = createTestDataSource([])
        const worker = new ExportWorker(dataSource, writer, { batchSize: 10 })

        const result = await worker.run()

        expect(result.totalRows).toBe(0)
        expect(result.batchesProcessed).toBe(0)
        expect(result.errors).toBe(0)
        expect(writer.openCount).toBe(1)
        expect(writer.closeCount).toBe(1)
        expect(writer.writeCount).toBe(0)
        expect(writer.isClosed).toBe(true)
        expect(writer.isAborted).toBe(false)
      })

      it('does not call writeBatch for empty dataset', async () => {
        const writer = createTestWriter()
        const writeBatchSpy = vi.spyOn(writer, 'writeBatch')
        const dataSource = createTestDataSource([])
        const worker = new ExportWorker(dataSource, writer)

        await worker.run()

        expect(writeBatchSpy).not.toHaveBeenCalled()
      })
    })

    // -----------------------------------------------------------------------
    describe('Single Row', () => {
      it('processes exactly one row', async () => {
        const writer = createTestWriter()
        const row = { id: 'single', value: 42 }
        const dataSource = createTestDataSource([row])
        const worker = new ExportWorker(dataSource, writer, { batchSize: 10 })

        const result = await worker.run()

        expect(result.totalRows).toBe(1)
        expect(result.batchesProcessed).toBe(1)
        expect(writer.batches).toEqual([[row]])
      })

      it('handles single row with batch size of 1', async () => {
        const writer = createTestWriter()
        const row = { id: 'single' }
        const dataSource = createTestDataSource([row])
        const worker = new ExportWorker(dataSource, writer, { batchSize: 1 })

        const result = await worker.run()

        expect(result.totalRows).toBe(1)
        expect(result.batchesProcessed).toBe(1)
      })
    })

    // -----------------------------------------------------------------------
    describe('Batch Size Edge Cases', () => {
      it('handles batch size larger than dataset', async () => {
        const writer = createTestWriter()
        const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 100 })

        const result = await worker.run()

        expect(result.totalRows).toBe(5)
        expect(result.batchesProcessed).toBe(1)
        expect(writer.batches[0]).toHaveLength(5)
      })

      it('handles dataset size exactly equal to batch size', async () => {
        const writer = createTestWriter()
        const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 10 })

        const result = await worker.run()

        expect(result.totalRows).toBe(10)
        expect(result.batchesProcessed).toBe(1)
        expect(writer.batches[0]).toHaveLength(10)
      })

      it('handles dataset size one more than batch size', async () => {
        const writer = createTestWriter()
        const rows = Array.from({ length: 11 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 10 })

        const result = await worker.run()

        expect(result.totalRows).toBe(11)
        expect(result.batchesProcessed).toBe(2)
        expect(writer.batches[0]).toHaveLength(10)
        expect(writer.batches[1]).toHaveLength(1)
      })

      it('handles dataset size one less than batch size', async () => {
        const writer = createTestWriter()
        const rows = Array.from({ length: 9 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 10 })

        const result = await worker.run()

        expect(result.totalRows).toBe(9)
        expect(result.batchesProcessed).toBe(1)
        expect(writer.batches[0]).toHaveLength(9)
      })

      it('uses default batch size of 500 when not specified', async () => {
        const writer = createTestWriter()
        const openCursorFn = vi.fn().mockReturnValue({
          [Symbol.asyncIterator]() {
            return { async next() { return { done: true as const, value: undefined } } }
          },
        })
        const dataSource = createTestDataSource([], { openCursor: openCursorFn })
        const worker = new ExportWorker(dataSource, writer)

        await worker.run()

        expect(openCursorFn).toHaveBeenCalledWith(500)
      })

      it('respects custom batch size', async () => {
        const writer = createTestWriter()
        const openCursorFn = vi.fn().mockReturnValue({
          [Symbol.asyncIterator]() {
            return { async next() { return { done: true as const, value: undefined } } }
          },
        })
        const dataSource = createTestDataSource([], { openCursor: openCursorFn })
        const worker = new ExportWorker(dataSource, writer, { batchSize: 250 })

        await worker.run()

        expect(openCursorFn).toHaveBeenCalledWith(250)
      })
    })

    // -----------------------------------------------------------------------
    describe('Large Dataset Boundaries', () => {
      it('processes exactly 1000 rows across multiple batches', async () => {
        const writer = createTestWriter()
        const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 100 })

        const result = await worker.run()

        expect(result.totalRows).toBe(1000)
        expect(result.batchesProcessed).toBe(10)
        expect(writer.batches).toHaveLength(10)
        writer.batches.forEach((batch) => expect(batch).toHaveLength(100))
      })

      it('handles prime-number batch distribution', async () => {
        const writer = createTestWriter()
        const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 7 })

        const result = await worker.run()

        // 14 full batches of 7 + 1 remainder batch of 2
        expect(result.totalRows).toBe(100)
        expect(result.batchesProcessed).toBe(15)
        expect(writer.batches[13]).toHaveLength(7)
        expect(writer.batches[14]).toHaveLength(2)
      })
    })

    // -----------------------------------------------------------------------
    describe('Data Type Boundaries', () => {
      it('handles rows with null values', async () => {
        const writer = createTestWriter()
        const rows = [{ id: 1, value: null }, { id: 2, value: null }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.totalRows).toBe(2)
        expect(writer.batches[0]).toEqual(rows)
      })

      it('handles rows with undefined values', async () => {
        const writer = createTestWriter()
        const rows = [{ id: 1, value: undefined }, { id: 2, optional: undefined }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.totalRows).toBe(2)
        expect(writer.batches[0]).toEqual(rows)
      })

      it('handles rows with empty strings', async () => {
        const writer = createTestWriter()
        const rows = [{ id: 1, name: '' }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.totalRows).toBe(1)
        expect(writer.batches[0][0].name).toBe('')
      })

      it('handles rows with special numeric values', async () => {
        const writer = createTestWriter()
        const rows = [
          { id: 1, value: 0 },
          { id: 2, value: -0 },
          { id: 3, value: Infinity },
          { id: 4, value: -Infinity },
          { id: 5, value: NaN },
        ]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.totalRows).toBe(5)
        expect(writer.batches[0]).toHaveLength(5)
      })

      it('handles rows with deeply nested objects', async () => {
        const writer = createTestWriter()
        const rows = [
          { id: 1, nested: { level1: { level2: { level3: { value: 'deep' } } } } },
        ]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.totalRows).toBe(1)
        expect(writer.batches[0][0]).toEqual(rows[0])
      })

      it('handles rows with arrays', async () => {
        const writer = createTestWriter()
        const rows = [
          { id: 1, tags: [] },
          { id: 2, tags: ['a', 'b', 'c'] },
          { id: 3, tags: [1, 2, 3] },
        ]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.totalRows).toBe(3)
        expect(writer.batches[0]).toEqual(rows)
      })
    })

    // -----------------------------------------------------------------------
    describe('Duplicate Handling', () => {
      it('processes duplicate rows without deduplication', async () => {
        const writer = createTestWriter()
        const duplicate = { id: 1, value: 'same' }
        const rows = [duplicate, duplicate, duplicate]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.totalRows).toBe(3)
        expect(writer.batches[0]).toEqual([duplicate, duplicate, duplicate])
      })

      it('maintains duplicate row order across batch boundaries', async () => {
        const writer = createTestWriter()
        const rows = [
          { id: 1, value: 'a' },
          { id: 1, value: 'a' },
          { id: 2, value: 'b' },
          { id: 1, value: 'a' },
        ]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 2 })

        await worker.run()

        expect(writer.batches.flat()).toEqual(rows)
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('State Transition Invariants', () => {
    // -----------------------------------------------------------------------
    describe('Writer Lifecycle (standalone guard checks)', () => {
      let writer: ReturnType<typeof createTestWriter>

      beforeEach(() => { writer = createTestWriter() })

      it('enforces open before write', async () => {
        await expect(writer.writeBatch([{ id: 1 }])).rejects.toThrow('Cannot write to unopened writer')
      })

      it('enforces open before close', async () => {
        await expect(writer.close()).rejects.toThrow('Cannot close unopened writer')
      })

      it('prevents double open', async () => {
        await writer.open()
        await expect(writer.open()).rejects.toThrow('Writer already open')
      })

      it('prevents write after close', async () => {
        await writer.open()
        await writer.close()
        await expect(writer.writeBatch([{ id: 1 }])).rejects.toThrow('Cannot write to unopened writer')
      })

      it('prevents write after abort — aborted flag checked first', async () => {
        await writer.open()
        await writer.abort()
        await expect(writer.writeBatch([{ id: 1 }])).rejects.toThrow('Cannot write to aborted writer')
      })

      it('prevents close after abort — aborted flag checked first', async () => {
        await writer.open()
        await writer.abort()
        await expect(writer.close()).rejects.toThrow('Cannot close aborted writer')
      })

      it('prevents reopen after close', async () => {
        await writer.open()
        await writer.close()
        await expect(writer.open()).rejects.toThrow('Writer cannot be reopened after close/abort')
      })

      it('prevents reopen after abort', async () => {
        await writer.open()
        await writer.abort()
        await expect(writer.open()).rejects.toThrow('Writer cannot be reopened after close/abort')
      })
    })

    // -----------------------------------------------------------------------
    describe('ExportWorker lifecycle ordering', () => {
      it('calls open → writeBatch → close in order for a successful export', async () => {
        const writer = createTestWriter()
        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        await worker.run()

        expect(writer.openCount).toBe(1)
        expect(writer.writeCount).toBe(1)
        expect(writer.closeCount).toBe(1)
        expect(writer.abortCount).toBe(0)
      })

      it('calls open → writeBatch → abort (no close) on write failure', async () => {
        const writer = createTestWriter()
        // Override writeBatch; tracking counters still live on writer
        const originalWriteBatch = writer.writeBatch.bind(writer)
        writer.writeBatch = vi.fn(async (_rows: ExportRow[]) => {
          writer.writeCount++ // keep count consistent with override
          void originalWriteBatch  // not called — we're simulating failure
          throw new Error('Write failed')
        })

        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Write failed')

        expect(writer.openCount).toBe(1)
        expect(writer.closeCount).toBe(0)
        expect(writer.abortCount).toBe(1)
      })
    })

    // -----------------------------------------------------------------------
    describe('Error State Consistency', () => {
      it('stops processing and aborts after a write failure', async () => {
        const writer = createTestWriter()
        let writeAttempts = 0
        writer.writeBatch = vi.fn(async () => {
          writeAttempts++
          if (writeAttempts === 2) throw new Error('Second batch failed')
        })

        const rows = Array.from({ length: 3 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 1 })

        await expect(worker.run()).rejects.toThrow('Second batch failed')

        expect(writeAttempts).toBe(2)
        expect(writer.abortCount).toBe(1)
      })

      it('never opens the writer when getTotalCount fails', async () => {
        const writer = createTestWriter()
        const dataSource = createTestDataSource([], {
          getTotalCount: vi.fn(async () => { throw new Error('Count failed') }),
        })
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Count failed')

        expect(writer.openCount).toBe(0)
        expect(writer.closeCount).toBe(0)
        expect(writer.abortCount).toBe(0)
      })

      it('never writes when open() throws, and does not call abort', async () => {
        // ExportWorker.run() does not wrap the open() call in try/catch, so
        // abort() is not invoked — the error propagates before the try block.
        const writer = createTestWriter({
          open: async () => { throw new Error('Open failed') },
        })
        const dataSource = createTestDataSource([{ id: 1 }])
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Open failed')

        expect(writer.writeCount).toBe(0)
        expect(writer.closeCount).toBe(0)
        expect(writer.abortCount).toBe(0)
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('Failure Recovery', () => {
    // -----------------------------------------------------------------------
    describe('Data Source Failures', () => {
      it('aborts writer when cursor throws on first batch', async () => {
        const writer = createTestWriter()
        const dataSource: ExportDataSource = {
          getTotalCount: vi.fn(async () => 10),
          openCursor(): AsyncIterable<ExportRow[]> {
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() { throw new Error('Cursor initialization failed') },
                }
              },
            }
          },
        }
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Cursor initialization failed')

        expect(writer.openCount).toBe(1)
        expect(writer.abortCount).toBe(1)
        expect(writer.closeCount).toBe(0)
      })

      it('aborts writer when cursor throws mid-stream', async () => {
        const writer = createTestWriter()
        let batchCount = 0
        const dataSource: ExportDataSource = {
          getTotalCount: vi.fn(async () => 10),
          openCursor(): AsyncIterable<ExportRow[]> {
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    batchCount++
                    if (batchCount === 1) return { done: false as const, value: [{ id: 1 }] }
                    throw new Error('Cursor failed mid-stream')
                  },
                }
              },
            }
          },
        }
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Cursor failed mid-stream')

        expect(writer.writeCount).toBe(1)
        expect(writer.abortCount).toBe(1)
        expect(writer.closeCount).toBe(0)
      })

      it('propagates the original error object from cursor failure', async () => {
        const writer = createTestWriter()
        const customError = new Error('Database connection lost')
        customError.name = 'ConnectionError'

        const dataSource: ExportDataSource = {
          getTotalCount: vi.fn(async () => 10),
          openCursor(): AsyncIterable<ExportRow[]> {
            return {
              [Symbol.asyncIterator]() {
                return { async next() { throw customError } }
              },
            }
          },
        }
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toBe(customError)
      })
    })

    // -----------------------------------------------------------------------
    describe('Writer Failures', () => {
      it('aborts on first write failure — does not close', async () => {
        const writer = createTestWriter({
          writeBatch: async () => { throw new Error('Disk full') },
        })
        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Disk full')

        expect(writer.openCount).toBe(1)
        expect(writer.abortCount).toBe(1)
        expect(writer.closeCount).toBe(0)
      })

      it('aborts after N successful batches followed by a failure', async () => {
        const writer = createTestWriter()
        let writeCount = 0
        writer.writeBatch = vi.fn(async (rows: ExportRow[]) => {
          writeCount++
          if (writeCount === 3) throw new Error('Third batch failed')
          writer.batches.push([...rows])
        })

        const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 1 })

        await expect(worker.run()).rejects.toThrow('Third batch failed')

        expect(writeCount).toBe(3)
        expect(writer.abortCount).toBe(1)
        expect(writer.closeCount).toBe(0)
      })

      it('propagates abort() error when abort itself throws', async () => {
        // ExportWorker.run() does `await this.writer.abort()` in the catch block
        // without swallowing errors, so the abort error surfaces.
        const writer = createTestWriter({
          writeBatch: async () => { throw new Error('Write failed') },
          abort: async () => { throw new Error('Abort also failed') },
        })
        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Abort also failed')
      })

      it('propagates close() error and still calls abort()', async () => {
        // close() is called inside the try block in ExportWorker.run(), so a
        // close failure is caught by the outer catch, which calls abort().
        const writer = createTestWriter({
          close: async () => { throw new Error('Close failed') },
        })
        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Close failed')

        // writeBatch succeeded; close threw; abort was then called by the catch block
        expect(writer.writeCount).toBe(1)
        expect(writer.abortCount).toBe(1)
      })
    })

    // -----------------------------------------------------------------------
    describe('Partial Failure Scenarios', () => {
      it('does not retry failed batches automatically', async () => {
        const writer = createTestWriter()
        const writeBatchSpy = vi.fn(async (rows: ExportRow[]) => {
          if ((rows[0].id as number) === 2) throw new Error('Batch 2 failed')
          writer.batches.push([...rows])
        })
        writer.writeBatch = writeBatchSpy

        const rows = Array.from({ length: 4 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 1 })

        await expect(worker.run()).rejects.toThrow('Batch 2 failed')

        // Batches 0, 1, 2 attempted; 2 throws → no batch 3
        expect(writeBatchSpy).toHaveBeenCalledTimes(3)
      })

      it('stops processing all remaining batches after first failure', async () => {
        const writer = createTestWriter()
        const processedIds: number[] = []
        writer.writeBatch = vi.fn(async (rows: ExportRow[]) => {
          const id = rows[0].id as number
          processedIds.push(id)
          if (id === 2) throw new Error('Stop here')
        })

        const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 1 })

        await expect(worker.run()).rejects.toThrow('Stop here')

        expect(processedIds).toEqual([0, 1, 2])
      })

      it('preserves successfully written data up to the failure point', async () => {
        const writer = createTestWriter()
        let callCount = 0
        writer.writeBatch = vi.fn(async (rows: ExportRow[]) => {
          callCount++
          if (callCount === 3) throw new Error('Fail on third batch')
          writer.batches.push([...rows])
        })

        const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, value: `row${i}` }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 10 })

        await expect(worker.run()).rejects.toThrow('Fail on third batch')

        expect(writer.batches).toHaveLength(2)
        expect(writer.batches.flat()).toEqual(rows.slice(0, 20))
      })
    })

    // -----------------------------------------------------------------------
    describe('Idempotency and Retry Safety', () => {
      it('produces identical batch layout on repeated runs', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)

        const w1 = createTestWriter()
        await new ExportWorker(dataSource, w1, { batchSize: 3 }).run()

        const w2 = createTestWriter()
        await new ExportWorker(dataSource, w2, { batchSize: 3 }).run()

        expect(w1.batches).toEqual(w2.batches)
      })

      it('maintains strict row order across all batches', async () => {
        const writer = createTestWriter()
        const rows = Array.from({ length: 100 }, (_, i) => ({ seq: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 7 })

        await worker.run()

        writer.batches.flat().forEach((row, i) => {
          expect(row.seq).toBe(i)
        })
      })

      it('does not mutate source rows during processing', async () => {
        const rows = [
          { id: 1, tags: ['a', 'b'] },
          { id: 2, tags: ['c', 'd'] },
        ]
        const snapshot = JSON.parse(JSON.stringify(rows)) as typeof rows
        const dataSource = createTestDataSource(rows)

        const writer = createTestWriter()
        await new ExportWorker(dataSource, writer).run()

        expect(rows).toEqual(snapshot)
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('Concurrent and Async Safety', () => {
    // -----------------------------------------------------------------------
    describe('Async Iterator Contract', () => {
      it('handles async delays in cursor iteration', async () => {
        const writer = createTestWriter()
        const dataSource: ExportDataSource = {
          getTotalCount: vi.fn(async () => 2),
          openCursor(): AsyncIterable<ExportRow[]> {
            let count = 0
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    await new Promise((r) => setTimeout(r, 10))
                    if (count >= 2) return { done: true as const, value: undefined }
                    count++
                    return { done: false as const, value: [{ id: count }] }
                  },
                }
              },
            }
          },
        }
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.totalRows).toBe(2)
        expect(result.batchesProcessed).toBe(2)
      })

      it('handles async delays in writeBatch', async () => {
        const writer = createTestWriter()
        const originalWrite = writer.writeBatch.bind(writer)
        writer.writeBatch = vi.fn(async (rows: ExportRow[]) => {
          await new Promise((r) => setTimeout(r, 10))
          return originalWrite(rows)
        })

        const rows = [{ id: 1 }, { id: 2 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 1 })

        const result = await worker.run()

        expect(result.totalRows).toBe(2)
        expect(writer.batches).toHaveLength(2)
      })

      it('pumpExportBatches processes all batches in order', async () => {
        const seen: number[] = []
        const batches: ExportRow[][] = [[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]

        async function* gen() { for (const b of batches) yield b }

        await pumpExportBatches(gen(), async (rows) => {
          seen.push(rows[0].id as number)
        })

        expect(seen).toEqual([1, 2, 3])
      })

      it('pumpExportBatches returns accurate totals', async () => {
        const batches: ExportRow[][] = [
          [{ id: 1 }, { id: 2 }],
          [{ id: 3 }],
          [{ id: 4 }, { id: 5 }, { id: 6 }],
        ]

        async function* gen() { for (const b of batches) yield b }

        const result = await pumpExportBatches(gen(), async () => {})

        expect(result.totalRows).toBe(6)
        expect(result.batchesProcessed).toBe(3)
      })
    })

    // -----------------------------------------------------------------------
    describe('Concurrent Execution Safety', () => {
      it('rejects a second concurrent run on the same writer (double-open guard)', async () => {
        // The test writer enforces single-open semantics, so the second worker
        // to call open() will be rejected with "Writer already open".
        const writer = createTestWriter()
        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)

        const worker1 = new ExportWorker(dataSource, writer)
        const worker2 = new ExportWorker(dataSource, writer)

        const [r1, r2] = await Promise.allSettled([worker1.run(), worker2.run()])

        const statuses = [r1.status, r2.status]
        expect(statuses).toContain('fulfilled')
        expect(statuses).toContain('rejected')

        const rejected = [r1, r2].find((r) => r.status === 'rejected') as PromiseRejectedResult
        expect(rejected.reason.message).toMatch(/Writer already open/)
      })

      it('handles multiple sequential exports on the same data source without interference', async () => {
        const rows = [{ id: 1 }, { id: 2 }]
        const dataSource = createTestDataSource(rows)

        const w1 = createTestWriter()
        await new ExportWorker(dataSource, w1).run()

        const w2 = createTestWriter()
        await new ExportWorker(dataSource, w2).run()

        expect(w1.batches).toEqual(w2.batches)
      })
    })

    // -----------------------------------------------------------------------
    describe('Resource Cleanup', () => {
      it('always closes writer on successful empty export', async () => {
        const writer = createTestWriter()
        const dataSource = createTestDataSource([])
        const worker = new ExportWorker(dataSource, writer)

        await worker.run()

        expect(writer.isClosed).toBe(true)
        expect(writer.isAborted).toBe(false)
      })

      it('always aborts writer on error (no prior writes)', async () => {
        const writer = createTestWriter()
        const dataSource: ExportDataSource = {
          getTotalCount: vi.fn(async () => 1),
          openCursor(): AsyncIterable<ExportRow[]> {
            return {
              [Symbol.asyncIterator]() {
                return { async next() { throw new Error('Immediate failure') } }
              },
            }
          },
        }
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Immediate failure')

        expect(writer.isAborted).toBe(true)
        expect(writer.isClosed).toBe(false)
      })

      it('calls abort exactly once on failure', async () => {
        const writer = createTestWriter()
        writer.writeBatch = vi.fn(async () => { throw new Error('Write error') })

        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toThrow('Write error')

        expect(writer.abortCount).toBe(1)
      })

      it('calls close exactly once on success', async () => {
        const writer = createTestWriter()
        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        await worker.run()

        expect(writer.closeCount).toBe(1)
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('Result Metrics', () => {
    // -----------------------------------------------------------------------
    describe('Timing Metrics', () => {
      it('records startTime as a valid ISO 8601 string', async () => {
        const writer = createTestWriter()
        const dataSource = createTestDataSource([])
        const worker = new ExportWorker(dataSource, writer)

        const before = new Date()
        const result = await worker.run()
        const after = new Date()

        const startTime = new Date(result.startTime)
        expect(startTime.getTime()).toBeGreaterThanOrEqual(before.getTime())
        expect(startTime.getTime()).toBeLessThanOrEqual(after.getTime())
      })

      it('records duration as a non-negative number', async () => {
        const writer = createTestWriter()
        const dataSource = createTestDataSource([{ id: 1 }])
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.duration).toBeGreaterThanOrEqual(0)
        expect(typeof result.duration).toBe('number')
      })

      it('records non-zero duration when writes take measurable time', async () => {
        const writer = createTestWriter()
        const originalWrite = writer.writeBatch.bind(writer)
        writer.writeBatch = vi.fn(async (rows: ExportRow[]) => {
          await new Promise((r) => setTimeout(r, 15))
          return originalWrite(rows)
        })

        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.duration).toBeGreaterThan(0)
      })
    })

    // -----------------------------------------------------------------------
    describe('Count Metrics', () => {
      it('reports accurate totalRows for a multi-batch export', async () => {
        const writer = createTestWriter()
        const rows = Array.from({ length: 47 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { batchSize: 10 })

        const result = await worker.run()

        expect(result.totalRows).toBe(47)
        expect(result.batchesProcessed).toBe(5)
      })

      it('reports zero errors on a clean export', async () => {
        const writer = createTestWriter()
        const dataSource = createTestDataSource([{ id: 1 }, { id: 2 }])
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(result.errors).toBe(0)
      })
    })

    // -----------------------------------------------------------------------
    describe('Result Shape', () => {
      it('returns all required fields with correct types', async () => {
        const writer = createTestWriter()
        const dataSource = createTestDataSource([{ id: 1 }])
        const worker = new ExportWorker(dataSource, writer)

        const result = await worker.run()

        expect(typeof result.totalRows).toBe('number')
        expect(typeof result.batchesProcessed).toBe('number')
        expect(typeof result.errors).toBe('number')
        expect(typeof result.duration).toBe('number')
        expect(typeof result.startTime).toBe('string')
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('Logging and Observability', () => {
    // -----------------------------------------------------------------------
    describe('Logger Integration', () => {
      it('logs start message containing total row count', async () => {
        const writer = createTestWriter()
        const logs: string[] = []
        const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, { logger: (m) => logs.push(m) })

        await worker.run()

        const startLog = logs.find((l) => l.includes('Export started'))
        expect(startLog).toBeDefined()
        expect(startLog).toContain('100 rows')
      })

      it('logs each batch with running total', async () => {
        const writer = createTestWriter()
        const logs: string[] = []
        const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, {
          batchSize: 2,
          logger: (m) => logs.push(m),
        })

        await worker.run()

        expect(logs.some((l) => l.includes('Batch 1 written') && l.includes('2/5'))).toBe(true)
        expect(logs.some((l) => l.includes('Batch 2 written') && l.includes('4/5'))).toBe(true)
        expect(logs.some((l) => l.includes('Batch 3 written') && l.includes('5/5'))).toBe(true)
      })

      it('logs completion summary with row and batch counts', async () => {
        const writer = createTestWriter()
        const logs: string[] = []
        const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, {
          batchSize: 5,
          logger: (m) => logs.push(m),
        })

        await worker.run()

        const done = logs.find((l) => l.includes('Export completed'))
        expect(done).toBeDefined()
        expect(done).toContain('10 rows')
        expect(done).toContain('2 batches')
      })

      it('logs batch failure with error message', async () => {
        const writer = createTestWriter()
        const logs: string[] = []
        let call = 0
        writer.writeBatch = vi.fn(async (rows: ExportRow[]) => {
          call++
          if (call === 2) throw new Error('Network timeout')
          writer.batches.push([...rows])
        })

        const rows = Array.from({ length: 3 }, (_, i) => ({ id: i }))
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, {
          batchSize: 1,
          logger: (m) => logs.push(m),
        })

        await expect(worker.run()).rejects.toThrow('Network timeout')

        const failLog = logs.find((l) => l.includes('Batch 2 failed'))
        expect(failLog).toBeDefined()
        expect(failLog).toContain('Network timeout')
      })

      it('works without a logger (no-op default)', async () => {
        const writer = createTestWriter()
        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer) // no logger option

        await expect(worker.run()).resolves.toBeDefined()
      })
    })

    // -----------------------------------------------------------------------
    describe('Error Message Quality', () => {
      it('preserves the original error object from data source', async () => {
        const writer = createTestWriter()
        const original = new Error('Database query timeout after 30s')
        const dataSource = createTestDataSource([], {
          getTotalCount: vi.fn(async () => { throw original }),
        })
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toBe(original)
      })

      it('preserves the original error object from writer', async () => {
        const writer = createTestWriter()
        const original = new Error('S3 upload failed: access denied')
        writer.writeBatch = vi.fn(async () => { throw original })

        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer)

        await expect(worker.run()).rejects.toBe(original)
      })

      it('logs "Unknown write error" for non-Error thrown values', async () => {
        const writer = createTestWriter()
        const logs: string[] = []
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        writer.writeBatch = vi.fn(async () => { throw 'string-error' })

        const rows = [{ id: 1 }]
        const dataSource = createTestDataSource(rows)
        const worker = new ExportWorker(dataSource, writer, {
          logger: (m) => logs.push(m),
        })

        await expect(worker.run()).rejects.toBe('string-error')

        const errLog = logs.find((l) => l.includes('failed'))
        expect(errLog).toContain('Unknown write error')
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('Interface Contract Validation', () => {
    // -----------------------------------------------------------------------
    describe('ExportDataSource shape', () => {
      it('exposes getTotalCount() returning a Promise<number>', async () => {
        const ds = createTestDataSource([{ id: 1 }])
        const count = await ds.getTotalCount()
        expect(typeof count).toBe('number')
      })

      it('exposes openCursor() returning an AsyncIterable', () => {
        const ds = createTestDataSource([])
        const cursor = ds.openCursor(10)
        expect(Symbol.asyncIterator in cursor).toBe(true)
      })
    })

    // -----------------------------------------------------------------------
    describe('ExportWriter shape', () => {
      it('open() returns a Promise', () => {
        const writer = createTestWriter()
        const result = writer.open()
        expect(result).toBeInstanceOf(Promise)
        // suppress unhandled-rejection noise
        result.catch(() => {})
      })

      it('writeBatch() returns a Promise', async () => {
        const writer = createTestWriter()
        await writer.open()
        const result = writer.writeBatch([{ id: 1 }])
        expect(result).toBeInstanceOf(Promise)
        await result
      })

      it('close() returns a Promise', async () => {
        const writer = createTestWriter()
        await writer.open()
        const result = writer.close()
        expect(result).toBeInstanceOf(Promise)
        await result
      })

      it('abort() returns a Promise', () => {
        const writer = createTestWriter()
        const result = writer.abort()
        expect(result).toBeInstanceOf(Promise)
        result.catch(() => {})
      })
    })

    // -----------------------------------------------------------------------
    describe('ExportRow type flexibility', () => {
      it('accepts rows with arbitrary key-value pairs', async () => {
        const writer = createTestWriter()
        const rows: ExportRow[] = [
          { id: 1, name: 'test', active: true },
          { differentKeys: 'allowed', count: 42 },
          { nested: { deep: { value: 123 } } },
        ]
        const ds = createTestDataSource(rows)
        const worker = new ExportWorker(ds, writer)

        const result = await worker.run()

        expect(result.totalRows).toBe(3)
        expect(writer.batches[0]).toEqual(rows)
      })
    })
  })
})
