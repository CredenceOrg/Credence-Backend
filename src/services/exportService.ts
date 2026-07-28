import type { Writable } from 'node:stream'
import { DEFAULT_EXPORT_MAX_ROWS } from '../config/constants.js'
import { ExportWorker } from '../jobs/exportWorker.js'
import type {
  ExportDataSource,
  ExportRow,
  ExportWorkerOptions,
  ExportWorkerResult,
  ExportWriter,
} from '../jobs/exportTypes.js'
import { ExportTooLargeError } from '../lib/errors.js'
import type { AuditLogService } from './audit/index.js'
import type { AuditLogEntry } from './audit/types.js'

export interface AuditLogExportParams {
  startDate: Date
  endDate: Date
  tenantId?: string
  allowSuperScope?: boolean
}

export interface ExportServiceOptions {
  defaultBatchSize?: number
  /**
   * Maximum rows allowed in a single export. When the matching dataset exceeds
   * this limit the export is rejected before the writer opens or streaming starts.
   */
  maxRows?: number
}

export interface ExportSizeCheckResult {
  rowCount: number
  maxRows: number
}

async function* batchEntries(
  source: AsyncIterable<AuditLogEntry>,
  batchSize: number,
): AsyncGenerator<ExportRow[]> {
  let batch: ExportRow[] = []
  for await (const entry of source) {
    batch.push(entry)
    if (batch.length >= batchSize) {
      yield batch
      batch = []
    }
  }
  if (batch.length > 0) {
    yield batch
  }
}

function writeWithBackpressure(
  writable: NodeJS.WritableStream,
  chunk: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      writable.off('drain', onDrain)
      reject(err)
    }
    const onDrain = () => {
      writable.off('error', onError)
      resolve()
    }

    const ok = writable.write(chunk, (err) => {
      if (err) {
        onError(err)
      }
    })

    if (ok) {
      writable.off('error', onError)
      resolve()
    } else {
      writable.once('drain', onDrain)
      writable.once('error', onError)
    }
  })
}

/**
 * NDJSON export writer that respects Writable backpressure (waits for drain).
 */
export function createNdjsonExportWriter(writable: Writable): ExportWriter {
  let opened = false

  return {
    async open() {
      opened = true
    },
    async writeBatch(rows: ExportRow[]) {
      if (!opened) {
        throw new Error('Export writer is not open')
      }
      for (const row of rows) {
        await writeWithBackpressure(writable, `${JSON.stringify(row)}\n`)
      }
    },
    async close() {
      opened = false
      await new Promise<void>((resolve, reject) => {
        writable.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
    },
    async abort() {
      opened = false
      writable.destroy()
    },
  }
}

/**
 * In-memory writer for tests; discards payload after write resolves.
 */
export function createDiscardExportWriter(): ExportWriter {
  return {
    async open() {},
    async writeBatch(_rows: ExportRow[]) {},
    async close() {},
    async abort() {},
  }
}

export class ExportService {
  private readonly defaultBatchSize: number
  private readonly maxRows: number

  constructor(
    private readonly auditLog: AuditLogService,
    options: ExportServiceOptions = {},
  ) {
    this.defaultBatchSize = options.defaultBatchSize ?? 500
    this.maxRows = options.maxRows ?? DEFAULT_EXPORT_MAX_ROWS
  }

  getMaxRows(): number {
    return this.maxRows
  }

  createAuditLogDataSource(params: AuditLogExportParams): ExportDataSource {
    const { startDate, endDate, tenantId, allowSuperScope } = params
    const scopeOptions = allowSuperScope ? { allowSuperScope: true as const } : undefined
    const filters = {
      from: startDate.toISOString(),
      to: endDate.toISOString(),
    }
    const auditLog = this.auditLog
    const batchSize = this.defaultBatchSize

    return {
      getTotalCount: async () => {
        let total = 0
        let cursor: string | undefined
        while (true) {
          const page = await auditLog.getLogs(tenantId, filters, batchSize, cursor, scopeOptions)
          total += page.logs.length
          if (!page.hasNextPage || !page.nextCursor) {
            break
          }
          cursor = page.nextCursor
        }
        return total
      },
      openCursor(requestedBatchSize: number) {
        const stream = auditLog.exportLogsStream(startDate, endDate, tenantId, scopeOptions)
        return batchEntries(stream, requestedBatchSize)
      },
    }
  }

  /**
   * Count matching rows up to `stopAfter` (inclusive), stopping early once the
   * cap is exceeded. Used to reject oversized exports before streaming.
   */
  async countRowsUpTo(
    params: AuditLogExportParams,
    stopAfter: number,
  ): Promise<number> {
    const { startDate, endDate, tenantId, allowSuperScope } = params
    const scopeOptions = allowSuperScope ? { allowSuperScope: true as const } : undefined
    const filters = {
      from: startDate.toISOString(),
      to: endDate.toISOString(),
    }

    let total = 0
    let cursor: string | undefined
    while (true) {
      const page = await this.auditLog.getLogs(
        tenantId,
        filters,
        this.defaultBatchSize,
        cursor,
        scopeOptions,
      )
      total += page.logs.length
      if (total > stopAfter) {
        return total
      }
      if (!page.hasNextPage || !page.nextCursor) {
        break
      }
      cursor = page.nextCursor
    }
    return total
  }

  /**
   * Reject the export when the matching dataset exceeds {@link maxRows}.
   * Performs a capped count only — does not open a writer or stream rows.
   */
  async assertWithinRowLimit(
    params: AuditLogExportParams,
  ): Promise<ExportSizeCheckResult> {
    const rowCount = await this.countRowsUpTo(params, this.maxRows)
    if (rowCount > this.maxRows) {
      throw new ExportTooLargeError(
        `Export would include at least ${rowCount} rows, exceeding the maximum of ${this.maxRows}`,
        { rowCount, maxRows: this.maxRows },
      )
    }
    return { rowCount, maxRows: this.maxRows }
  }

  async runAuditLogExport(
    params: AuditLogExportParams,
    writer: ExportWriter,
    workerOptions: ExportWorkerOptions & { skipRowLimitCheck?: boolean } = {},
  ): Promise<ExportWorkerResult> {
    // Cap check first — reject oversized payloads before opening the writer
    // or running the expensive streaming pipeline.
    if (!workerOptions.skipRowLimitCheck) {
      await this.assertWithinRowLimit(params)
    }

    const dataSource = this.createAuditLogDataSource(params)
    const worker = new ExportWorker(dataSource, writer, {
      batchSize: workerOptions.batchSize ?? this.defaultBatchSize,
      logger: workerOptions.logger,
    })
    return worker.run()
  }
}
