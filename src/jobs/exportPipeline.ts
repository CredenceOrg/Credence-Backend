import type { ExportRow } from './exportTypes.js'

/**
 * Pulls one batch at a time from the cursor and awaits the writer before
 * requesting the next batch, yielding to the event loop between batches
 * so row objects can be reclaimed under load.
 */
export async function pumpExportBatches(
  cursor: AsyncIterable<ExportRow[]>,
  writeBatch: (rows: ExportRow[]) => Promise<void>,
): Promise<{ totalRows: number; batchesProcessed: number }> {
  let totalRows = 0
  let batchesProcessed = 0

  for await (const batch of cursor) {
    await writeBatch(batch)
    totalRows += batch.length
    batchesProcessed++
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  return { totalRows, batchesProcessed }
}
