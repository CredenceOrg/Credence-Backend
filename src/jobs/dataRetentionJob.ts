import { type RetentionConfig, getEffectiveEntityTtl } from '../config/retention.js'
import { RetentionRepository } from '../repositories/retentionRepository.js'
import type { Queryable } from '../db/repositories/queryable.js'
import type { EvidenceStorageService } from '../services/evidence/storage.js'
import type { AuditLogService } from '../services/audit/index.js'

export interface RetentionEntityAudit {
  entity: string
  expiredCount: number
  deletedCount: number
  ttlDays: number
  dryRun: boolean
  orgId?: string
}

export interface DataRetentionResult {
  startTime: string
  duration: number
  dryRun: boolean
  orgId?: string
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
    private readonly auditLogService?: AuditLogService,
  ) {
    this.repo = new RetentionRepository(db, config.dryRun)
    this.logger = logger ?? (() => {})
  }

  async run(orgId?: string): Promise<DataRetentionResult> {
    const start = Date.now()
    const startTime = new Date().toISOString()
    const { dryRun, batchLimit } = this.config

    const orgPrefix = orgId ? ` [org=${orgId}]` : ''
    this.logger(
      `[retention] Starting run${orgPrefix} — dryRun=${dryRun} batchLimit=${batchLimit}`,
    )

    const scoreTtl = getEffectiveEntityTtl(this.config, 'scoreHistory', orgId)
    const auditTtl = getEffectiveEntityTtl(this.config, 'auditLogs', orgId)
    const slashTtl = getEffectiveEntityTtl(this.config, 'slashEvents', orgId)
    const outboxTtl = getEffectiveEntityTtl(this.config, 'outboxEvents', orgId)
    const evidenceTtl = getEffectiveEntityTtl(this.config, 'evidence', orgId)

    const audits: RetentionEntityAudit[] = await Promise.all([
      this.processEntity(
        'score_history',
        scoreTtl,
        batchLimit,
        () => this.repo.countExpiredScoreHistory(scoreTtl, orgId),
        () => this.repo.deleteExpiredScoreHistory(scoreTtl, batchLimit, orgId),
        orgId,
      ),
      this.processEntity(
        'audit_logs',
        auditTtl,
        batchLimit,
        () => this.repo.countExpiredAuditLogs(auditTtl, orgId),
        () => this.repo.deleteExpiredAuditLogs(auditTtl, batchLimit, orgId),
        orgId,
      ),
      this.processEntity(
        'slash_events',
        slashTtl,
        batchLimit,
        () => this.repo.countExpiredSlashEvents(slashTtl, orgId),
        () => this.repo.deleteExpiredSlashEvents(slashTtl, batchLimit, orgId),
        orgId,
      ),
      this.processEntity(
        'outbox_events',
        outboxTtl,
        batchLimit,
        () => this.repo.countExpiredOutboxEvents(outboxTtl, orgId),
        () => this.repo.deleteExpiredOutboxEvents(outboxTtl, batchLimit, orgId),
        orgId,
      ),
      this.processEvidenceEntity(
        evidenceTtl,
        batchLimit,
        orgId,
      ),
    ])

    const totalDeleted = audits.reduce((sum, a) => sum + a.deletedCount, 0)
    const totalExpired = audits.reduce((sum, a) => sum + a.expiredCount, 0)
    const duration = Date.now() - start

    this.logger(
      `[retention] Run complete${orgPrefix} — totalExpired=${totalExpired} totalDeleted=${totalDeleted} duration=${duration}ms`,
    )

    if (this.auditLogService) {
      try {
        await this.auditLogService.logAction({
          tenantId: orgId ?? '00000000-0000-0000-0000-000000000000',
          actorId: 'system:retention_job',
          actorEmail: 'system@credence.internal',
          action: 'DATA_RETENTION_ENFORCEMENT',
          resourceType: 'system',
          resourceId: orgId ?? 'all_orgs',
          details: {
            dryRun,
            totalExpired,
            totalDeleted,
            durationMs: duration,
            entities: audits,
          },
          status: 'success',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger(`[retention] Warning: failed to write audit log: ${msg}`)
      }
    }

    return { startTime, duration, dryRun, orgId, entities: audits, totalDeleted, totalExpired }
  }

  async runForOrg(orgId: string): Promise<DataRetentionResult> {
    return this.run(orgId)
  }

  private async processEntity(
    name: string,
    ttlDays: number,
    batchLimit: number,
    countFn: () => Promise<{ expiredCount: number }>,
    deleteFn: () => Promise<{ deletedCount: number; dryRun: boolean }>,
    orgId?: string,
  ): Promise<RetentionEntityAudit> {
    if (ttlDays === 0) {
      this.logger(`[retention] ${name} — ttlDays=0, skipping`)
      return { entity: name, expiredCount: 0, deletedCount: 0, ttlDays: 0, dryRun: this.config.dryRun, orgId }
    }

    const { expiredCount } = await countFn()

    this.logger(
      `[retention] ${name} — ttlDays=${ttlDays} expiredCount=${expiredCount}${this.config.dryRun ? ' (dry-run)' : ''}`,
    )

    if (expiredCount === 0) {
      return { entity: name, expiredCount: 0, deletedCount: 0, ttlDays, dryRun: this.config.dryRun, orgId }
    }

    const { deletedCount, dryRun } = await deleteFn()

    if (!dryRun) {
      this.logger(`[retention] ${name} — deleted ${deletedCount} rows`)
    }

    return { entity: name, expiredCount, deletedCount, ttlDays, dryRun, orgId }
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
    orgId?: string,
  ): Promise<RetentionEntityAudit> {
    if (ttlDays === 0) {
      this.logger(`[retention] evidence — ttlDays=0, skipping`)
      return { entity: 'evidence', expiredCount: 0, deletedCount: 0, ttlDays: 0, dryRun: this.config.dryRun, orgId }
    }

    // Count expired evidence (ignoring legal hold, already shredded, already deleted)
    const { expiredCount } = await this.repo.countExpiredEvidence(ttlDays, orgId)

    this.logger(
      `[retention] evidence — ttlDays=${ttlDays} expiredCount=${expiredCount}${this.config.dryRun ? ' (dry-run)' : ''}`,
    )

    if (expiredCount === 0) {
      return { entity: 'evidence', expiredCount: 0, deletedCount: 0, ttlDays, dryRun: this.config.dryRun, orgId }
    }

    // Dry-run: count but don't shred
    if (this.config.dryRun || !this.evidenceService) {
      if (!this.evidenceService) {
        this.logger('[retention] evidence — no EvidenceStorageService provided, skipping shred')
      }
      return { entity: 'evidence', expiredCount, deletedCount: 0, ttlDays, dryRun: this.config.dryRun, orgId }
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
      await this.repo.deleteExpiredEvidence(ttlDays, batchLimit, orgId)
    }

    this.logger(`[retention] evidence — shredded ${shreddedCount} records`)

    return { entity: 'evidence', expiredCount, deletedCount: shreddedCount, ttlDays, dryRun: false, orgId }
  }
}
