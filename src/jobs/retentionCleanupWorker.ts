import { parseCronToInterval } from './scheduler.js'
import type {
  RetentionDisposition,
  RetentionPolicyRepository,
  RetentionRecordClass,
} from '../db/repositories/retentionPolicyRepository.js'
import type { OrganizationRepository } from '../db/repositories/organizationRepository.js'
import type { RetentionRecordRepository } from '../db/repositories/retentionRecordRepository.js'

export interface RetentionCleanupWorkerOptions {
  eventBatchSize?: number
  auditBatchSize?: number
  maxBatchesPerClass?: number
  logger?: (message: string) => void
}

export interface RetentionCleanupWorkerResult {
  processedOrganizations: number
  archivedEvents: number
  deletedAudits: number
  skippedOrganizations: number
  duration: number
  startTime: string
}

export class RetentionCleanupWorker {
  private readonly eventBatchSize: number
  private readonly auditBatchSize: number
  private readonly maxBatchesPerClass: number
  private readonly logger: (message: string) => void

  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly policies: RetentionPolicyRepository,
    private readonly records: RetentionRecordRepository,
    options: RetentionCleanupWorkerOptions = {}
  ) {
    this.eventBatchSize = options.eventBatchSize ?? 250
    this.auditBatchSize = options.auditBatchSize ?? 250
    this.maxBatchesPerClass = options.maxBatchesPerClass ?? 20
    this.logger = options.logger ?? (() => {})
  }

  async run(now: Date = new Date()): Promise<RetentionCleanupWorkerResult> {
    const startedAt = Date.now()
    const startTime = now.toISOString()
    let processedOrganizations = 0
    let archivedEvents = 0
    let deletedAudits = 0
    let skippedOrganizations = 0

    const organizations = await this.organizations.listAll()

    for (const organization of organizations) {
      const eventPolicy = await this.policies.resolvePolicy(organization.id, 'event')
      const auditPolicy = await this.policies.resolvePolicy(organization.id, 'audit')

      if (!eventPolicy && !auditPolicy) {
        skippedOrganizations += 1
        continue
      }

      archivedEvents += await this.processClass(
        organization.id,
        'event',
        eventPolicy?.disposition ?? null,
        eventPolicy?.retentionDays ?? null,
        now
      )
      deletedAudits += await this.processClass(
        organization.id,
        'audit',
        auditPolicy?.disposition ?? null,
        auditPolicy?.retentionDays ?? null,
        now
      )

      processedOrganizations += 1
    }

    return {
      processedOrganizations,
      archivedEvents,
      deletedAudits,
      skippedOrganizations,
      duration: Date.now() - startedAt,
      startTime,
    }
  }

  private async processClass(
    organizationId: string,
    recordClass: RetentionRecordClass,
    disposition: RetentionDisposition | null,
    retentionDays: number | null,
    now: Date
  ): Promise<number> {
    if (!disposition || retentionDays === null) {
      return 0
    }

    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
    const batchSize = recordClass === 'event' ? this.eventBatchSize : this.auditBatchSize
    let processed = 0

    for (let i = 0; i < this.maxBatchesPerClass; i += 1) {
      const count =
        recordClass === 'event'
          ? await this.records.archiveEligibleEventRecords(organizationId, cutoff, batchSize)
          : await this.records.deleteEligibleAuditRecords(organizationId, cutoff, batchSize)

      processed += count
      if (count < batchSize) {
        break
      }
    }

    if (processed > 0) {
      this.logger(
        `Processed ${processed} ${recordClass} records for organization ${organizationId} via ${disposition}`
      )
    }

    return processed
  }
}

export function getRetentionCleanupIntervalMs(
  cronExpression = process.env.RETENTION_CLEANUP_CRON ?? '0 0 * * *'
): number {
  return parseCronToInterval(cronExpression)
}
