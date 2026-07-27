import type { Writable } from 'node:stream'
import { ExportWorker } from '../jobs/exportWorker.js'
import type {
  ExportDataSource,
  ExportRow,
  ExportWorkerOptions,
  ExportWorkerResult,
  ExportWriter,
} from '../jobs/exportTypes.js'
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

  constructor(
    private readonly auditLog: AuditLogService,
    options: ExportServiceOptions = {},
  ) {
    this.defaultBatchSize = options.defaultBatchSize ?? 500
  }

  createAuditLogDataSource(params: AuditLogExportParams): ExportDataSource {
    const { startDate, endDate, tenantId, allowSuperScope } = params
    const scopeOptions = allowSuperScope ? { allowSuperScope: true as const } : undefined
    const filters = {
      from: startDate.toISOString(),
      to: endDate.toISOString(),
    }
    const auditLog = this.auditLog

    return {
      getTotalCount: async () => {
        let total = 0
        let cursor: string | undefined
        const pageSize = this.defaultBatchSize
        while (true) {
          const page = await auditLog.getLogs(tenantId, filters, pageSize, cursor, scopeOptions)
          total += page.logs.length
          if (!page.hasNextPage || !page.nextCursor) {
            break
          }
          cursor = page.nextCursor
        }
        return total
      },
      openCursor(batchSize: number) {
        const stream = auditLog.exportLogsStream(startDate, endDate, tenantId, scopeOptions)
        return batchEntries(stream, batchSize)
      },
    }
  }

  async runAuditLogExport(
    params: AuditLogExportParams,
    writer: ExportWriter,
    workerOptions: ExportWorkerOptions = {},
  ): Promise<ExportWorkerResult> {
    const dataSource = this.createAuditLogDataSource(params)
    const worker = new ExportWorker(dataSource, writer, {
      batchSize: workerOptions.batchSize ?? this.defaultBatchSize,
      logger: workerOptions.logger,
    })
    return worker.run()
  }
}
