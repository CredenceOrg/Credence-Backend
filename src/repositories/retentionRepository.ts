/**
 * RetentionRepository
 *
 * Provides count-then-delete helpers for each entity type managed by the
 * data-retention job.  All mutating methods are no-ops when `dryRun` is true
 * so the caller never needs to branch on that flag.
 */

import type { Queryable } from '../db/repositories/queryable.js'

export interface RetentionCountResult {
  entity: string
  expiredCount: number
  ttlDays: number
  orgId?: string
}

export interface RetentionDeleteResult {
  entity: string
  deletedCount: number
  ttlDays: number
  dryRun: boolean
  orgId?: string
}

export class RetentionRepository {
  constructor(
    private readonly db: Queryable,
    private readonly dryRun: boolean = false,
  ) {}

  // ── score_history ──────────────────────────────────────────────────────

  async countExpiredScoreHistory(ttlDays: number, orgId?: string): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'score_history', expiredCount: 0, ttlDays, orgId }
    const params: unknown[] = [ttlDays]
    let sql = `SELECT COUNT(*)::text AS cnt FROM score_history
       WHERE computed_at < NOW() - ($1 || ' days')::interval`
    if (orgId) {
      params.push(orgId)
      sql += ` AND tenant_id = $2`
    }

    const result = await this.db.query<{ cnt: string }>(sql, params)
    return {
      entity: 'score_history',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
      orgId,
    }
  }

  async deleteExpiredScoreHistory(
    ttlDays: number,
    batchLimit: number,
    orgId?: string,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'score_history', deletedCount: 0, ttlDays, dryRun: this.dryRun, orgId }
    }
    const params: unknown[] = [ttlDays, batchLimit]
    let orgFilter = ''
    if (orgId) {
      params.push(orgId)
      orgFilter = ` AND tenant_id = $3`
    }

    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT id FROM score_history
         WHERE computed_at < NOW() - ($1 || ' days')::interval${orgFilter}
         LIMIT $2
       )
       DELETE FROM score_history WHERE id IN (SELECT id FROM rows)
       RETURNING 1`,
      params,
    )
    return {
      entity: 'score_history',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
      orgId,
    }
  }

  // ── audit_logs ─────────────────────────────────────────────────────────

  async countExpiredAuditLogs(ttlDays: number, orgId?: string): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'audit_logs', expiredCount: 0, ttlDays, orgId }
    const params: unknown[] = [ttlDays]
    let sql = `SELECT COUNT(*)::text AS cnt FROM audit_logs
       WHERE occurred_at < NOW() - ($1 || ' days')::interval`
    if (orgId) {
      params.push(orgId)
      sql += ` AND tenant_id = $2`
    }

    const result = await this.db.query<{ cnt: string }>(sql, params)
    return {
      entity: 'audit_logs',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
      orgId,
    }
  }

  async deleteExpiredAuditLogs(
    ttlDays: number,
    batchLimit: number,
    orgId?: string,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'audit_logs', deletedCount: 0, ttlDays, dryRun: this.dryRun, orgId }
    }
    const params: unknown[] = [ttlDays, batchLimit]
    let orgFilter = ''
    if (orgId) {
      params.push(orgId)
      orgFilter = ` AND tenant_id = $3`
    }

    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT id FROM audit_logs
         WHERE occurred_at < NOW() - ($1 || ' days')::interval${orgFilter}
         LIMIT $2
       )
       DELETE FROM audit_logs WHERE id IN (SELECT id FROM rows)
       RETURNING 1`,
      params,
    )
    return {
      entity: 'audit_logs',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
      orgId,
    }
  }

  // ── slash_events ───────────────────────────────────────────────────────

  async countExpiredSlashEvents(ttlDays: number, orgId?: string): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'slash_events', expiredCount: 0, ttlDays, orgId }
    const params: unknown[] = [ttlDays]
    let sql = `SELECT COUNT(*)::text AS cnt FROM slash_events
       WHERE created_at < NOW() - ($1 || ' days')::interval`
    if (orgId) {
      params.push(orgId)
      sql += ` AND tenant_id = $2`
    }

    const result = await this.db.query<{ cnt: string }>(sql, params)
    return {
      entity: 'slash_events',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
      orgId,
    }
  }

  async deleteExpiredSlashEvents(
    ttlDays: number,
    batchLimit: number,
    orgId?: string,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'slash_events', deletedCount: 0, ttlDays, dryRun: this.dryRun, orgId }
    }
    const params: unknown[] = [ttlDays, batchLimit]
    let orgFilter = ''
    if (orgId) {
      params.push(orgId)
      orgFilter = ` AND tenant_id = $3`
    }

    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT id FROM slash_events
         WHERE created_at < NOW() - ($1 || ' days')::interval${orgFilter}
         LIMIT $2
       )
       DELETE FROM slash_events WHERE id IN (SELECT id FROM rows)
       RETURNING 1`,
      params,
    )
    return {
      entity: 'slash_events',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
      orgId,
    }
  }

  // ── evidence ──────────────────────────────────────────────────────────

  async countExpiredEvidence(ttlDays: number, orgId?: string): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'evidence', expiredCount: 0, ttlDays, orgId }
    const params: unknown[] = [ttlDays]
    let sql = `SELECT COUNT(*)::text AS cnt FROM evidence
       WHERE created_at < NOW() - ($1 || ' days')::interval
         AND deleted_at IS NULL
         AND legal_hold = false
         AND shredded_at IS NULL`
    if (orgId) {
      params.push(orgId)
      sql += ` AND tenant_id = $2`
    }

    const result = await this.db.query<{ cnt: string }>(sql, params)
    return {
      entity: 'evidence',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
      orgId,
    }
  }

  async deleteExpiredEvidence(
    ttlDays: number,
    batchLimit: number,
    orgId?: string,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'evidence', deletedCount: 0, ttlDays, dryRun: this.dryRun, orgId }
    }
    const params: unknown[] = [ttlDays, batchLimit]
    let orgFilter = ''
    if (orgId) {
      params.push(orgId)
      orgFilter = ` AND tenant_id = $3`
    }

    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT evidence_id FROM evidence
         WHERE created_at < NOW() - ($1 || ' days')::interval
           AND deleted_at IS NULL
           AND legal_hold = false
           AND shredded_at IS NULL${orgFilter}
         LIMIT $2
       )
       UPDATE evidence
       SET deleted_at = NOW()
       WHERE evidence_id IN (SELECT evidence_id FROM rows)
       RETURNING 1`,
      params,
    )
    return {
      entity: 'evidence',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
      orgId,
    }
  }

  // ── outbox_events ──────────────────────────────────────────────────────

  async countExpiredOutboxEvents(ttlDays: number, orgId?: string): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'outbox_events', expiredCount: 0, ttlDays, orgId }
    const params: unknown[] = [ttlDays]
    let sql = `SELECT COUNT(*)::text AS cnt FROM event_outbox
       WHERE created_at < NOW() - ($1 || ' days')::interval
         AND status IN ('published', 'failed')`
    if (orgId) {
      params.push(orgId)
      sql += ` AND (tenant_id = $2 OR org_id = $2)`
    }

    const result = await this.db.query<{ cnt: string }>(sql, params)
    return {
      entity: 'outbox_events',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
      orgId,
    }
  }

  async deleteExpiredOutboxEvents(
    ttlDays: number,
    batchLimit: number,
    orgId?: string,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'outbox_events', deletedCount: 0, ttlDays, dryRun: this.dryRun, orgId }
    }
    const params: unknown[] = [ttlDays, batchLimit]
    let orgFilter = ''
    if (orgId) {
      params.push(orgId)
      orgFilter = ` AND (tenant_id = $3 OR org_id = $3)`
    }

    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT id FROM event_outbox
         WHERE created_at < NOW() - ($1 || ' days')::interval
           AND status IN ('published', 'failed')${orgFilter}
         LIMIT $2
       )
       DELETE FROM event_outbox WHERE id IN (SELECT id FROM rows)
       RETURNING 1`,
      params,
    )
    return {
      entity: 'outbox_events',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
      orgId,
    }
  }
}
