import { workerPool } from '../db/pool.js'
import { BulkJobRepository } from '../db/repositories/bulkJobRepository.js'
import { verificationService } from '../services/verificationService.js'
import { bulkQueueWaitSeconds } from '../middleware/metrics.js'

export class BulkWorker {
  private readonly repo: BulkJobRepository

  constructor() {
    this.repo = new BulkJobRepository(workerPool)
  }

  /** Claim and process a single job. */
  async processNext(): Promise<void> {
    const job = await this.repo.claimNextQueuedWfq()
    if (!job) return

    try {
      const waitSeconds = (Date.now() - job.created_at.getTime()) / 1000
      bulkQueueWaitSeconds.observe({ org_id: job.org_id }, waitSeconds)

      const payload = JSON.parse(job.payload)
      const addresses: string[] = payload.addresses ?? []

      // Process bulk verification in chunks to avoid memory spikes
      const { results, errors } = await verificationService.verifyBulkChunked(addresses)

      await this.repo.updateStatus(job.id, 'completed', { resultsCount: results.length, errorsCount: errors.length })
    } catch (err) {
      console.error(`Bulk worker failed for job ${job.id}:`, err)
      await this.repo.updateStatus(job.id, 'failed', { failureReason: 'INTERNAL_ERROR' })
    }
  }
}

export function createBulkWorker() {
  return new BulkWorker()
}
