import { ReportRepository } from '../db/repositories/reportRepository.js'
import { ReportJob, ReportJobStatus } from '../jobs/types.js'
import { cache } from '../cache/redis.js'
import { ReportStorageService } from './reportStorage.js'
import { ReportWorker } from '../jobs/reportWorker.js'
import { computeRequestHash } from '../utils/hash.js'
import { loadConfig } from '../config/index.js'

const REPORT_CACHE_TTL = 60 // 1 minute for active jobs

export class ReportService {
  private readonly worker: ReportWorker
  private config: ReturnType<typeof loadConfig> | null = null

  constructor(
    private readonly reportRepository: ReportRepository,
    private readonly storage = new ReportStorageService()
  ) {
    this.worker = new ReportWorker(reportRepository, storage)
  }

  private getConfig() {
    if (!this.config) {
      try {
        this.config = loadConfig()
      } catch {
        // Fallback to defaults if config loading fails
        this.config = { reports: { maxConcurrentJobsPerOrg: 10 } } as any
      }
    }
    return this.config
  }

  /**
   * Starts a report generation job asynchronously.
   * Enforces per-org concurrency cap and deduplicates identical in-flight requests.
   * Returns the existing job ID if an identical request is already in progress.
   */
  async startReportGeneration(type: string, tenantId: string = 'default', params?: Record<string, unknown>): Promise<ReportJob> {
    // Compute request hash for deduplication
    const requestHash = computeRequestHash({ type, params })
    const dedupKey = `report-dedup:${tenantId}:${requestHash}`
    const countKey = `report-count:${tenantId}`

    // Check for identical in-flight request
    const existingJobId = await cache.get<string>('report', dedupKey)
    if (existingJobId) {
      const existingJob = await this.reportRepository.findById(existingJobId)
      if (existingJob && !this.isTerminalStatus(existingJob.status)) {
        return existingJob
      }
    }

    // Check concurrency cap
    const config = this.getConfig()
    if (!config) throw new Error('Config not loaded')
    const cap = config.reports.maxConcurrentJobsPerOrg
    if (cap > 0) {
      const activeJobsStr = await cache.get<string>('report', countKey)
      const activeJobs = activeJobsStr ? parseInt(activeJobsStr, 10) : 0

      if (activeJobs >= cap) {
        throw new Error(`Organization has reached maximum concurrent report jobs (${cap})`)
      }
    }

    const job = await this.reportRepository.create(type)

    // Track dedup for this request
    await cache.set('report', dedupKey, job.id, 300) // 5 minutes

    // Update active count
    if (cap > 0) {
      const activeJobsStr = await cache.get<string>('report', countKey)
      const activeJobs = activeJobsStr ? parseInt(activeJobsStr, 10) : 0
      await cache.set('report', countKey, String(activeJobs + 1), 300)
    }

    // Delegate to the report worker for background processing
    this.worker.processReport(job.id, type, tenantId).catch((error) => {
      console.error(`Error processing report job ${job.id}:`, error)
    })

    return job
  }

  /**
   * Check if a job status is terminal (no longer consuming resources).
   */
  private isTerminalStatus(status: string): boolean {
    return status === ReportJobStatus.COMPLETED || status === ReportJobStatus.FAILED
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
