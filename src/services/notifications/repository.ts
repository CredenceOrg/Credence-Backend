import type { Queryable } from '../../db/repositories/queryable.js'
import type {
  SendAttempt,
  NotificationStore,
  NotificationMetrics,
} from './types.js'
import { randomUUID } from 'crypto'

/**
 * PostgreSQL-backed notification store for tracking send attempts.
 * Ensures idempotency via unique constraint on idempotency_key.
 */
export class NotificationRepository implements NotificationStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Create a new send attempt and mark it as pending.
   * Uses idempotency key to prevent duplicate entries.
   */
  async createSendAttempt(
    attempt: Omit<SendAttempt, 'id'>
  ): Promise<SendAttempt> {
    const id = randomUUID()

    // Check if this idempotency key already exists
    const existing = await this.getSendByIdempotencyKey(attempt.idempotencyKey)
    if (existing) {
      // Return the existing attempt instead of creating a duplicate
      return existing
    }

    const result = await this.db.query(
      `
      INSERT INTO notification_send_attempts (
        id, notification_id, idempotency_key, attempt_group,
        attempt_number, provider, status, attempted_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING 
        id, notification_id as "notificationId", idempotency_key as "idempotencyKey",
        attempt_group as "attemptGroup", attempt_number as "attemptNumber",
        provider, status, provider_response_id as "providerResponseId",
        error_message as "errorMessage", attempted_at as "attemptedAt", sent_at as "sentAt"
      `,
      [
        id,
        attempt.notificationId,
        attempt.idempotencyKey,
        attempt.attemptGroup,
        attempt.attemptNumber,
        attempt.provider,
        attempt.status,
        attempt.attemptedAt,
      ]
    )

    const record = result.rows[0] as Record<string, unknown>
    return this.mapRecord(record)
  }

  /**
   * Get the last send attempt for a notification.
   */
  async getLastSendAttempt(notificationId: string): Promise<SendAttempt | null> {
    const result = await this.db.query(
      `
      SELECT 
        id, notification_id as "notificationId", idempotency_key as "idempotencyKey",
        attempt_group as "attemptGroup", attempt_number as "attemptNumber",
        provider, status, provider_response_id as "providerResponseId",
        error_message as "errorMessage", attempted_at as "attemptedAt", sent_at as "sentAt"
      FROM notification_send_attempts
      WHERE notification_id = $1
      ORDER BY attempted_at DESC
      LIMIT 1
      `,
      [notificationId]
    )

    if (result.rows.length === 0) {
      return null
    }

    return this.mapRecord(result.rows[0] as Record<string, unknown>)
  }

  /**
   * Get all send attempts for a notification.
   */
  async getSendAttempts(notificationId: string): Promise<SendAttempt[]> {
    const result = await this.db.query(
      `
      SELECT 
        id, notification_id as "notificationId", idempotency_key as "idempotencyKey",
        attempt_group as "attemptGroup", attempt_number as "attemptNumber",
        provider, status, provider_response_id as "providerResponseId",
        error_message as "errorMessage", attempted_at as "attemptedAt", sent_at as "sentAt"
      FROM notification_send_attempts
      WHERE notification_id = $1
      ORDER BY attempted_at ASC
      `,
      [notificationId]
    )

    return result.rows.map(row => this.mapRecord(row as Record<string, unknown>))
  }

  /**
   * Update send attempt status and related fields.
   */
  async updateSendAttempt(
    attemptId: string,
    updates: Partial<
      Pick<SendAttempt, 'status' | 'sentAt' | 'providerResponseId' | 'errorMessage'>
    >
  ): Promise<void> {
    const setClause: string[] = ['updated_at = NOW()']
    const values: unknown[] = []
    let paramIndex = 1

    if (updates.status !== undefined) {
      setClause.push(`status = $${paramIndex++}`)
      values.push(updates.status)
    }

    if (updates.sentAt !== undefined) {
      setClause.push(`sent_at = $${paramIndex++}`)
      values.push(updates.sentAt)
    }

    if (updates.providerResponseId !== undefined) {
      setClause.push(`provider_response_id = $${paramIndex++}`)
      values.push(updates.providerResponseId)
    }

    if (updates.errorMessage !== undefined) {
      setClause.push(`error_message = $${paramIndex++}`)
      values.push(updates.errorMessage)
    }

    values.push(attemptId)

    await this.db.query(
      `
      UPDATE notification_send_attempts
      SET ${setClause.join(', ')}
      WHERE id = $${paramIndex}
      `,
      values
    )
  }

  /**
   * Get metrics for notification delivery.
   */
  async getMetrics(): Promise<NotificationMetrics> {
    const result = await this.db.query(`
      SELECT 
        COUNT(*) as total_attempts,
        COUNT(*) FILTER (WHERE status = 'sent') as successful_sends,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_sends,
        COUNT(*) FILTER (WHERE status = 'deduped') as deduplicated_sends,
        COUNT(DISTINCT notification_id) as unique_notifications
      FROM notification_send_attempts
    `)

    const row = result.rows[0] as Record<string, unknown>
    const totalAttempts = Number(row.total_attempts || 0)
    const uniqueNotifications = Number(row.unique_notifications || 1)

    return {
      totalAttempts,
      successfulSends: Number(row.successful_sends || 0),
      failedSends: Number(row.failed_sends || 0),
      deduplicatedSends: Number(row.deduplicated_sends || 0),
      averageAttemptsPerNotification:
        uniqueNotifications > 0
          ? totalAttempts / uniqueNotifications
          : 0,
    }
  }

  /**
   * Check if a send was already completed for an idempotency key.
   */
  async getSendByIdempotencyKey(idempotencyKey: string): Promise<SendAttempt | null> {
    const result = await this.db.query(
      `
      SELECT 
        id, notification_id as "notificationId", idempotency_key as "idempotencyKey",
        attempt_group as "attemptGroup", attempt_number as "attemptNumber",
        provider, status, provider_response_id as "providerResponseId",
        error_message as "errorMessage", attempted_at as "attemptedAt", sent_at as "sentAt"
      FROM notification_send_attempts
      WHERE idempotency_key = $1
      `,
      [idempotencyKey]
    )

    if (result.rows.length === 0) {
      return null
    }

    return this.mapRecord(result.rows[0] as Record<string, unknown>)
  }

  /**
   * Map database record to SendAttempt type.
   */
  private mapRecord(record: Record<string, unknown>): SendAttempt {
    return {
      id: record.id as string,
      notificationId: record.notificationId as string,
      idempotencyKey: record.idempotencyKey as string,
      attemptGroup: Number(record.attemptGroup),
      attemptNumber: Number(record.attemptNumber),
      provider: record.provider as string,
      status: record.status as SendAttempt['status'],
      providerResponseId: record.providerResponseId as string | undefined,
      errorMessage: record.errorMessage as string | undefined,
      attemptedAt: new Date(record.attemptedAt as string | Date),
      sentAt: record.sentAt
        ? new Date(record.sentAt as string | Date)
        : undefined,
    }
  }
}
