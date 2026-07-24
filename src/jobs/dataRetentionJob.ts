import type { RetentionConfig } from '../config/retention.js'
import { RetentionRepository } from '../repositories/retentionRepository.js'
import type { Queryable } from '../db/repositories/queryable.js'
import type { EvidenceStorageService } from '../services/evidence/storage.js'

export interface RetentionEntityAudit {
  entity: string
  expiredCount: number
  deletedCount: number
  ttlDays: number
  dryRun: boolean
}

export interface DataRetentionResult {
  startTime: string
  duration: number
  dryRun: boolean
  entities: RetentionEntityAudit[]
  totalDeleted: number
  totalExpired: number
}

export class DataRetentionJob {
  private readonly repo: RetentionRepository
  private readonly logger: (msg: string) => void

  constructor(
    private readonly db: Queryable,
    private readonly config: RetentionConfig,
    logger?: (msg: string) => void,
    private readonly evidenceService?: EvidenceStorageService,
  ) {
    this.repo = new RetentionRepository(db, config.dryRun)
    this.logger = logger ?? (() => {})
  }

  async run(): Promise<DataRetentionResult> {
    const start = Date.now()
    const startTime = new Date().toISOString()
    const { dryRun, batchLimit, entities } = this.config

    this.logger(
      `[retention] Starting run — dryRun=${dryRun} batchLimit=${batchLimit}`,
    )

    const audits: RetentionEntityAudit[] = await Promise.all([
      this.processEntity(
        'score_history',
        entities.scoreHistory.ttlDays,
        batchLimit,
        () => this.repo.countExpiredScoreHistory(entities.scoreHistory.ttlDays),
        () => this.repo.deleteExpiredScoreHistory(entities.scoreHistory.ttlDays, batchLimit),
      ),
      this.processEntity(
        'audit_logs',
        entities.auditLogs.ttlDays,
        batchLimit,
        () => this.repo.countExpiredAuditLogs(entities.auditLogs.ttlDays),
        () => this.repo.deleteExpiredAuditLogs(entities.auditLogs.ttlDays, batchLimit),
      ),
      this.processEntity(
        'slash_events',
        entities.slashEvents.ttlDays,
        batchLimit,
        () => this.repo.countExpiredSlashEvents(entities.slashEvents.ttlDays),
        () => this.repo.deleteExpiredSlashEvents(entities.slashEvents.ttlDays, batchLimit),
      ),
      this.processEntity(
        'outbox_events',
        entities.outboxEvents.ttlDays,
        batchLimit,
        () => this.repo.countExpiredOutboxEvents(entities.outboxEvents.ttlDays),
        () => this.repo.deleteExpiredOutboxEvents(entities.outboxEvents.ttlDays, batchLimit),
      ),
      this.processEvidenceEntity(
        entities.evidence.ttlDays,
        batchLimit,
      ),
    ])

    const totalDeleted = audits.reduce((sum, a) => sum + a.deletedCount, 0)
    const totalExpired = audits.reduce((sum, a) => sum + a.expiredCount, 0)
    const duration = Date.now() - start

    this.logger(
      `[retention] Run complete — totalExpired=${totalExpired} totalDeleted=${totalDeleted} duration=${duration}ms`,
    )

    return { startTime, duration, dryRun, entities: audits, totalDeleted, totalExpired }
  }

  private async processEntity(
    name: string,
    ttlDays: number,
    batchLimit: number,
    countFn: () => Promise<{ expiredCount: number }>,
    deleteFn: () => Promise<{ deletedCount: number; dryRun: boolean }>,
  ): Promise<RetentionEntityAudit> {
    if (ttlDays === 0) {
      this.logger(`[retention] ${name} — ttlDays=0, skipping`)
      return { entity: name, expiredCount: 0, deletedCount: 0, ttlDays: 0, dryRun: this.config.dryRun }
    }

    const { expiredCount } = await countFn()

    this.logger(
      `[retention] ${name} — ttlDays=${ttlDays} expiredCount=${expiredCount}${this.config.dryRun ? ' (dry-run)' : ''}`,
    )

    if (expiredCount === 0) {
      return { entity: name, expiredCount: 0, deletedCount: 0, ttlDays, dryRun: this.config.dryRun }
    }

    const { deletedCount, dryRun } = await deleteFn()

    if (!dryRun) {
      this.logger(`[retention] ${name} — deleted ${deletedCount} rows`)
    }

    return { entity: name, expiredCount, deletedCount, ttlDays, dryRun }
  }

  /**
   * Evidence is handled specially: instead of a plain SQL DELETE, it performs
   * crypto-shred (zeroizes the per-row DEK + encrypted blob), writes a signed
   * proof-of-erasure, and then soft-deletes the metadata row.
   *
   * Edge cases handled:
   *  - legal hold flag → skipped
   *  - already shredded → idempotent (counted but skipped)
   *  - dry run → counted but no mutation
   *  - ttlDays === 0 → skipped
   */
  private async processEvidenceEntity(
    ttlDays: number,
    batchLimit: number,
  ): Promise<RetentionEntityAudit> {
    if (ttlDays === 0) {
      this.logger(`[retention] evidence — ttlDays=0, skipping`)
      return { entity: 'evidence', expiredCount: 0, deletedCount: 0, ttlDays: 0, dryRun: this.config.dryRun }
    }

    // Count expired evidence (ignoring legal hold, already shredded, already deleted)
    const { expiredCount } = await this.repo.countExpiredEvidence(ttlDays)

    this.logger(
      `[retention] evidence — ttlDays=${ttlDays} expiredCount=${expiredCount}${this.config.dryRun ? ' (dry-run)' : ''}`,
    )

    if (expiredCount === 0) {
      return { entity: 'evidence', expiredCount: 0, deletedCount: 0, ttlDays, dryRun: this.config.dryRun }
    }

    // Dry-run: count but don't shred
    if (this.config.dryRun || !this.evidenceService) {
      if (!this.evidenceService) {
        this.logger('[retention] evidence — no EvidenceStorageService provided, skipping shred')
      }
      return { entity: 'evidence', expiredCount, deletedCount: 0, ttlDays, dryRun: this.config.dryRun }
    }

    // Perform crypto-shred via evidence service
    const expiredIds = this.evidenceService.getExpiredEvidenceIds(ttlDays)
    let shreddedCount = 0

    for (const id of expiredIds.slice(0, batchLimit)) {
      try {
        const result = await this.evidenceService.cryptoShredEvidence(id, 'RETENTION_JOB')
        this.logger(`[retention] evidence — crypto-shredded ${id} proof=${result.proofJwt.slice(0, 40)}...`)
        shreddedCount++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger(`[retention] evidence — failed to shred ${id}: ${message}`)
      }
    }

    // Soft-delete the metadata via repository
    if (shreddedCount > 0) {
      await this.repo.deleteExpiredEvidence(ttlDays, batchLimit)
    }

    this.logger(`[retention] evidence — shredded ${shreddedCount} records`)

    return { entity: 'evidence', expiredCount, deletedCount: shreddedCount, ttlDays, dryRun: false }
  }
}
