import type {
  ExportDataSource,
  ExportWriter,
  ExportWorkerOptions,
  ExportWorkerResult,
} from './exportTypes.js'
import { pumpExportBatches } from './exportPipeline.js'
export type { ExportWorkerOptions, ExportWorkerResult } from './exportTypes.js'

export class ExportWorker {
  private readonly batchSize: number
  private readonly logger: (message: string) => void

  constructor(
    private readonly dataSource: ExportDataSource,
    private readonly writer: ExportWriter,
    options: ExportWorkerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 500
    this.logger = options.logger ?? (() => {})
  }

  async run(): Promise<ExportWorkerResult> {
    const startTime = new Date().toISOString()
    const startMs = Date.now()

    let totalRows = 0
    let batchesProcessed = 0
    let errors = 0

    const totalCount = await this.dataSource.getTotalCount()
    this.logger(`Export started, ${totalCount} rows to process`)

    await this.writer.open()

    try {
      const cursor = this.dataSource.openCursor(this.batchSize)

      let batchIndex = 0
      let runningTotal = 0
      const pumped = await pumpExportBatches(cursor, async (batch) => {
        batchIndex++
        try {
          await this.writer.writeBatch(batch)
          runningTotal += batch.length
          this.logger(
            `Batch ${batchIndex} written (${batch.length} rows, ${runningTotal}/${totalCount} total)`,
          )
        } catch (error) {
          errors++
          const message = error instanceof Error ? error.message : 'Unknown write error'
          this.logger(`Batch ${batchIndex} failed: ${message}`)
          throw error
        }
      })
      totalRows = pumped.totalRows
      batchesProcessed = pumped.batchesProcessed

      await this.writer.close()
      this.logger(`Export completed: ${totalRows} rows in ${batchesProcessed} batches`)
    } catch (error) {
      await this.writer.abort()
      throw error
    }

    return {
      totalRows,
      batchesProcessed,
      errors,
      duration: Date.now() - startMs,
      startTime,
    }
  }
}

export function createExportWorker(
  dataSource: ExportDataSource,
  writer: ExportWriter,
  options?: ExportWorkerOptions,
): ExportWorker {
  return new ExportWorker(dataSource, writer, options)
}
