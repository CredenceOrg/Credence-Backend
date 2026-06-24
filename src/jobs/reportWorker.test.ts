import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReportWorker } from './reportWorker.js'
import { ReportService } from '../services/reportService.js'
import { ReportStorageService } from '../services/reportStorage.js'
import { ReportJobStatus } from './types.js'

vi.mock('../cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../cache/invalidation.js', () => ({
  invalidateCache: vi.fn(),
}))

describe('Report Worker — Integration', () => {
  let worker: ReportWorker
  let storage: ReportStorageService
  let mockRepo: any

  beforeEach(() => {
    ReportStorageService.reset()
    vi.clearAllMocks()

    process.env.REPORT_STORAGE_SIGNING_SECRET = 'test-report-integration-secret-32chr'
    process.env.REPORT_DOWNLOAD_BASE_URL = 'https://credence.example.com'
    storage = new ReportStorageService()

    mockRepo = {
      create: vi.fn(),
      findById: vi.fn(),
      updateStatus: vi.fn(),
    }

    worker = new ReportWorker(mockRepo, storage)
  })

  it('processes QUEUED → RUNNING → COMPLETED and persists artifact', async () => {
    const jobId = 'job-integration-1'
    const completedJob = {
      id: jobId,
      type: 'trust_score_summary',
      status: ReportJobStatus.COMPLETED,
      storageKey: 'reports/default/job-integration-1.pdf',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    mockRepo.updateStatus.mockResolvedValue(completedJob)
    mockRepo.findById.mockResolvedValue(completedJob)

    await worker.processReport(jobId, 'trust_score_summary', 'default')

    // Verify status transitions
    expect(mockRepo.updateStatus).toHaveBeenCalledWith(jobId, ReportJobStatus.RUNNING, undefined)

    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      jobId,
      ReportJobStatus.COMPLETED,
      expect.objectContaining({ storageKey: 'reports/default/job-integration-1.pdf' }),
    )

    // Verify artifact was persisted
    expect(storage.exists('reports/default/job-integration-1.pdf')).toBe(true)

    // Verify the artifact has content
    const data = storage.retrieve('reports/default/job-integration-1.pdf')
    expect(data).not.toBeNull()
    expect(data!.length).toBeGreaterThan(0)
  })

  it('transitions to FAILED when storage upload throws', async () => {
    const jobId = 'job-fail-1'
    const failedJob = {
      id: jobId,
      type: 'test-report',
      status: ReportJobStatus.FAILED,
      failureReason: 'INTERNAL_ERROR',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    mockRepo.updateStatus.mockResolvedValue(failedJob)
    mockRepo.findById.mockResolvedValue(failedJob)

    // Make uploadStream throw after RUNNING is set
    const origUpload = storage.uploadStream.bind(storage)
    storage.uploadStream = vi.fn().mockRejectedValue(new Error('Storage unavailable'))

    await worker.processReport(jobId, 'test-report', 'default')

    expect(mockRepo.updateStatus).toHaveBeenCalledWith(jobId, ReportJobStatus.RUNNING, undefined)
    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      jobId,
      ReportJobStatus.FAILED,
      expect.objectContaining({ failureReason: 'INTERNAL_ERROR' }),
    )
  })

  it('generates artifact with multi-page content', async () => {
    const jobId = 'job-multi-page'
    const completedJob = {
      id: jobId,
      type: 'long-report',
      status: ReportJobStatus.COMPLETED,
      storageKey: 'reports/default/job-multi-page.pdf',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    mockRepo.updateStatus.mockResolvedValue(completedJob)
    mockRepo.findById.mockResolvedValue(completedJob)

    await worker.processReport(jobId, 'long-report', 'default')

    const data = storage.retrieve('reports/default/job-multi-page.pdf')
    expect(data).not.toBeNull()
    const content = data!.toString('utf-8')
    expect(content).toContain('Report ID: job-multi-page')
    expect(content).toContain('Type: long-report')
    expect(content).toContain('--- Page 2 ---')
    expect(content).toContain('--- End of Report ---')
  })
})

describe('Report Worker → Service → Signed URL (full integration)', () => {
  it('end-to-end: status check returns valid signed download URL', async () => {
    ReportStorageService.reset()

    process.env.REPORT_STORAGE_SIGNING_SECRET = 'full-flow-integration-secret-32chr'
    process.env.REPORT_DOWNLOAD_BASE_URL = 'https://credence.example.com'
    const storage = new ReportStorageService()

    const mockRepo = {
      create: vi.fn(),
      findById: vi.fn(),
      updateStatus: vi.fn(),
    }

    const worker = new ReportWorker(mockRepo, storage)
    const mockJob = {
      id: 'e2e-job-1',
      type: 'trust_score_summary',
      status: ReportJobStatus.QUEUED,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    mockRepo.create.mockResolvedValue(mockJob)
    mockRepo.updateStatus.mockResolvedValue(undefined)
    mockRepo.findById.mockResolvedValue({
      ...mockJob,
      status: ReportJobStatus.COMPLETED,
      storageKey: 'reports/default/e2e-job-1.pdf',
    })

    // Create service (it bundles worker)
    const service = new ReportService(mockRepo as any, storage)

    // Start generation (worker runs in background)
    vi.useFakeTimers()
    const startPromise = service.startReportGeneration('trust_score_summary')

    // Allow all timers to flush so worker completes
    await vi.runAllTimersAsync()
    await startPromise

    // Verify artifact exists
    expect(storage.exists('reports/default/e2e-job-1.pdf')).toBe(true)

    // Status check returns signed URL
    const job = mockRepo.findById('e2e-job-1')
    const signedUrl = service.getSignedDownloadUrl(await job)
    expect(signedUrl).toContain('/api/reports/download/')
    expect(signedUrl).toContain('expires=')
    expect(signedUrl).toContain('signature=')

    vi.useRealTimers()
  })
})
