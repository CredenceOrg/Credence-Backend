import { ReportRepository } from '../db/repositories/reportRepository.js'
import { ReportJob, ReportJobStatus } from '../jobs/types.js'
import { cache } from '../cache/redis.js'
import { ReportStorageService } from './reportStorage.js'
import { ReportWorker } from '../jobs/reportWorker.js'

const REPORT_CACHE_TTL = 60 // 1 minute for active jobs

export class ReportService {
  private readonly worker: ReportWorker

  constructor(
    private readonly reportRepository: ReportRepository,
    private readonly storage = new ReportStorageService()
  ) {
    this.worker = new ReportWorker(reportRepository, storage)
  }

  /**
   * Starts a report generation job asynchronously.
   */
  async startReportGeneration(type: string, tenantId: string = 'default'): Promise<ReportJob> {
    const job = await this.reportRepository.create(type)

    // Delegate to the report worker for background processing
    this.worker.processReport(job.id, type, tenantId).catch((error) => {
      console.error(`Error processing report job ${job.id}:`, error)
    })

    return job
  }

  /**
   * Gets the status of a report job with caching.
   */
  async getReportStatus(id: string): Promise<ReportJob | null> {
    const cached = await cache.get<ReportJob>('report', id)

    if (cached) {
      return cached
    }

    const job = await this.reportRepository.findById(id)
    if (job) {
      // Cache with shorter TTL for active jobs
      const ttl = job.status === ReportJobStatus.COMPLETED || job.status === ReportJobStatus.FAILED
        ? 300 // 5 minutes for terminal states
        : REPORT_CACHE_TTL
      await cache.set('report', id, job, ttl)
    }

    return job
  }

  /**
   * Generate a signed download URL for a completed report's artifact.
   */
  getSignedDownloadUrl(job: ReportJob): string | null {
    if (!job.storageKey) {
      return null
    }
    const signed = this.storage.generateSignedUrl(job.storageKey)
    return signed.url
  }
}
