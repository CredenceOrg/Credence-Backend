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
}

export interface RetentionDeleteResult {
  entity: string
  deletedCount: number
  ttlDays: number
  dryRun: boolean
}

export class RetentionRepository {
  constructor(
    private readonly db: Queryable,
    private readonly dryRun: boolean = false,
  ) {}

  // ── score_history ──────────────────────────────────────────────────────

  async countExpiredScoreHistory(ttlDays: number): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'score_history', expiredCount: 0, ttlDays }
    const result = await this.db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM score_history
       WHERE computed_at < NOW() - ($1 || ' days')::interval`,
      [ttlDays],
    )
    return {
      entity: 'score_history',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
    }
  }

  async deleteExpiredScoreHistory(
    ttlDays: number,
    batchLimit: number,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'score_history', deletedCount: 0, ttlDays, dryRun: this.dryRun }
    }
    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT id FROM score_history
         WHERE computed_at < NOW() - ($1 || ' days')::interval
         LIMIT $2
       )
       DELETE FROM score_history WHERE id IN (SELECT id FROM rows)
       RETURNING 1`,
      [ttlDays, batchLimit],
    )
    return {
      entity: 'score_history',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
    }
  }

  // ── audit_logs ─────────────────────────────────────────────────────────

  async countExpiredAuditLogs(ttlDays: number): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'audit_logs', expiredCount: 0, ttlDays }
    const result = await this.db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM audit_logs
       WHERE occurred_at < NOW() - ($1 || ' days')::interval`,
      [ttlDays],
    )
    return {
      entity: 'audit_logs',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
    }
  }

  async deleteExpiredAuditLogs(
    ttlDays: number,
    batchLimit: number,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'audit_logs', deletedCount: 0, ttlDays, dryRun: this.dryRun }
    }
    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT id FROM audit_logs
         WHERE occurred_at < NOW() - ($1 || ' days')::interval
         LIMIT $2
       )
       DELETE FROM audit_logs WHERE id IN (SELECT id FROM rows)
       RETURNING 1`,
      [ttlDays, batchLimit],
    )
    return {
      entity: 'audit_logs',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
    }
  }

  // ── slash_events ───────────────────────────────────────────────────────

  async countExpiredSlashEvents(ttlDays: number): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'slash_events', expiredCount: 0, ttlDays }
    const result = await this.db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM slash_events
       WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [ttlDays],
    )
    return {
      entity: 'slash_events',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
    }
  }

  async deleteExpiredSlashEvents(
    ttlDays: number,
    batchLimit: number,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'slash_events', deletedCount: 0, ttlDays, dryRun: this.dryRun }
    }
    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT id FROM slash_events
         WHERE created_at < NOW() - ($1 || ' days')::interval
         LIMIT $2
       )
       DELETE FROM slash_events WHERE id IN (SELECT id FROM rows)
       RETURNING 1`,
      [ttlDays, batchLimit],
    )
    return {
      entity: 'slash_events',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
    }
  }

  // ── evidence ──────────────────────────────────────────────────────────

  async countExpiredEvidence(ttlDays: number): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'evidence', expiredCount: 0, ttlDays }
    const result = await this.db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM evidence
       WHERE created_at < NOW() - ($1 || ' days')::interval
         AND deleted_at IS NULL
         AND legal_hold = false
         AND shredded_at IS NULL`,
      [ttlDays],
    )
    return {
      entity: 'evidence',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
    }
  }

  async deleteExpiredEvidence(
    ttlDays: number,
    batchLimit: number,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'evidence', deletedCount: 0, ttlDays, dryRun: this.dryRun }
    }
    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT evidence_id FROM evidence
         WHERE created_at < NOW() - ($1 || ' days')::interval
           AND deleted_at IS NULL
           AND legal_hold = false
           AND shredded_at IS NULL
         LIMIT $2
       )
       UPDATE evidence
       SET deleted_at = NOW()
       WHERE evidence_id IN (SELECT evidence_id FROM rows)
       RETURNING 1`,
      [ttlDays, batchLimit],
    )
    return {
      entity: 'evidence',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
    }
  }

  // ── outbox_events ──────────────────────────────────────────────────────

  async countExpiredOutboxEvents(ttlDays: number): Promise<RetentionCountResult> {
    if (ttlDays === 0) return { entity: 'outbox_events', expiredCount: 0, ttlDays }
    const result = await this.db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM event_outbox
       WHERE created_at < NOW() - ($1 || ' days')::interval
         AND status IN ('published', 'failed')`,
      [ttlDays],
    )
    return {
      entity: 'outbox_events',
      expiredCount: parseInt(result.rows[0]?.cnt ?? '0', 10),
      ttlDays,
    }
  }

  async deleteExpiredOutboxEvents(
    ttlDays: number,
    batchLimit: number,
  ): Promise<RetentionDeleteResult> {
    if (ttlDays === 0 || this.dryRun) {
      return { entity: 'outbox_events', deletedCount: 0, ttlDays, dryRun: this.dryRun }
    }
    const result = await this.db.query<{ cnt: string }>(
      `WITH rows AS (
         SELECT id FROM event_outbox
         WHERE created_at < NOW() - ($1 || ' days')::interval
           AND status IN ('published', 'failed')
         LIMIT $2
       )
       DELETE FROM event_outbox WHERE id IN (SELECT id FROM rows)
       RETURNING 1`,
      [ttlDays, batchLimit],
    )
    return {
      entity: 'outbox_events',
      deletedCount: result.rowCount ?? 0,
      ttlDays,
      dryRun: false,
    }
  }
}
