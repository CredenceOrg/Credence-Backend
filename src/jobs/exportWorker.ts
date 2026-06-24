import type {
  ExportDataSource,
  ExportWriter,
  ExportWorkerOptions,
  ExportWorkerResult,
} from './exportTypes.js'
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

      for await (const batch of cursor) {
        try {
          await this.writer.writeBatch(batch)
          totalRows += batch.length
          batchesProcessed++

          this.logger(
            `Batch ${batchesProcessed} written (${batch.length} rows, ${totalRows}/${totalCount} total)`,
          )
        } catch (error) {
          errors++
          const message = error instanceof Error ? error.message : 'Unknown write error'
          this.logger(`Batch ${batchesProcessed + 1} failed: ${message}`)
          throw error
        }
      }

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
