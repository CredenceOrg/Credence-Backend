import { ReportJobStatus } from './types.js'
import { ReportRepository } from '../db/repositories/reportRepository.js'
import { ReportStorageService } from '../services/reportStorage.js'
import { invalidateCache } from '../cache/invalidation.js'
import { workerPool } from '../db/pool.js'

/**
 * Report worker that generates report artifacts as a streaming AsyncIterable
 * and persists them via ReportStorageService.
 *
 * Mirrors ExportWorker streaming patterns to avoid buffering large reports
 * in memory.
 */
export class ReportWorker {
  constructor(
    private readonly reportRepository: ReportRepository,
    private readonly storage: ReportStorageService
  ) {}

  /**
   * Process a report job from QUEUED → RUNNING → COMPLETED (or FAILED).
   * Generates the artifact as an async stream, uploads it, and persists
   * the storage key.
   */
  async processReport(jobId: string, type: string, tenantId: string = 'default'): Promise<void> {
    const storageKey = this.storage.makeKey(tenantId, jobId)

    try {
      await this.updateStatusAndInvalidate(jobId, ReportJobStatus.RUNNING)

      const reportStream = this.generateReportStream(jobId, type)
      await this.storage.uploadStream(storageKey, reportStream)

      await this.updateStatusAndInvalidate(jobId, ReportJobStatus.COMPLETED, {
        storageKey,
      })
    } catch (error) {
      console.error(`Error processing report job ${jobId}:`, error)
      await this.updateStatusAndInvalidate(jobId, ReportJobStatus.FAILED, {
        failureReason: 'INTERNAL_ERROR',
      })
    }
  }

  /**
   * Generate report content as a streaming AsyncIterable.
   * Each chunk is a Buffer produced on demand to avoid buffering the full
   * report in memory.
   */
  private async *generateReportStream(jobId: string, type: string): AsyncIterable<Buffer> {
    yield Buffer.from(`Report ID: ${jobId}\nType: ${type}\nGenerated: ${new Date().toISOString()}\n`, 'utf-8')

    await new Promise((resolve) => setTimeout(resolve, 500))

    yield Buffer.from('--- Page 2 ---\nSummary data placeholder\n', 'utf-8')

    await new Promise((resolve) => setTimeout(resolve, 500))

    yield Buffer.from('--- End of Report ---\n', 'utf-8')
  }

  /**
   * Update status and invalidate the cache so the status endpoint reflects
   * the change immediately.
   */
  private async updateStatusAndInvalidate(
    id: string,
    status: ReportJobStatus,
    metadata?: { failureReason?: string; storageKey?: string }
  ): Promise<void> {
    await this.reportRepository.updateStatus(id, status, metadata)

    const job = await this.reportRepository.findById(id)
    if (job) {
      await invalidateCache('report', id, job, {
        verify: true,
        verifyFn: (cached, fresh) => cached.status !== fresh.status,
      })
    }
  }
}

/**
 * Factory: creates a ReportWorker wired to the default pool and storage.
 */
export function createReportWorker(storage?: ReportStorageService): ReportWorker {
  const repo = new ReportRepository(workerPool)
  const svc = storage ?? new ReportStorageService()
  return new ReportWorker(repo, svc)
}
