import { getPool } from '../../db/pool.js'
import type {
  SlashRequest,
  CreateSlashRequestInput,
  ReviewSlashRequestInput,
  ExecuteSlashRequestInput,
  SlashRequestFilters,
  PaginatedSlashRequests,
} from './types.js'
import { SlashStatus } from './types.js'
import {
  validateCreateSlashRequest,
  isValidStatusTransition,
  getStatusTransitionError,
} from './validation.js'

/**
 * Service for managing slash requests
 */
export class SlashService {
  /**
   * Create a new slash request
   * 
   * @param input - Slash request input
   * @returns Created slash request
   * @throws Error if validation fails or database error occurs
   */
  async createSlashRequest(input: CreateSlashRequestInput): Promise<SlashRequest> {
    // Validate input
    const errors = validateCreateSlashRequest(input)
    if (errors.length > 0) {
      const errorMessages = errors.map((e) => `${e.field}: ${e.message}`).join('; ')
      throw new Error(`Validation failed: ${errorMessages}`)
    }

    const pool = getPool()
    const query = `
      INSERT INTO slash_requests (
        target_address,
        amount,
        reason,
        evidence_ref,
        submitted_by
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `

    try {
      const result = await pool.query(query, [
        input.targetAddress,
        input.amount,
        input.reason,
        input.evidenceRef,
        input.submittedBy,
      ])

      return this.mapRowToSlashRequest(result.rows[0])
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to create slash request: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * Get slash request by ID
   * 
   * @param id - Slash request ID
   * @returns Slash request or null if not found
   */
  async getSlashRequestById(id: string): Promise<SlashRequest | null> {
    const pool = getPool()
    const query = 'SELECT * FROM slash_requests WHERE id = $1'

    try {
      const result = await pool.query(query, [id])
      if (result.rows.length === 0) {
        return null
      }
      return this.mapRowToSlashRequest(result.rows[0])
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get slash request: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * List slash requests with optional filters
   * 
   * @param filters - Query filters
   * @returns Paginated list of slash requests
   */
  async listSlashRequests(
    filters: SlashRequestFilters = {}
  ): Promise<PaginatedSlashRequests> {
    const pool = getPool()
    const { status, targetAddress, submittedBy, limit = 50, offset = 0 } = filters

    // Build WHERE clause
    const conditions: string[] = []
    const params: any[] = []
    let paramIndex = 1

    if (status) {
      conditions.push(`status = $${paramIndex++}`)
      params.push(status)
    }

    if (targetAddress) {
      conditions.push(`target_address = $${paramIndex++}`)
      params.push(targetAddress)
    }

    if (submittedBy) {
      conditions.push(`submitted_by = $${paramIndex++}`)
      params.push(submittedBy)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Get total count
    const countQuery = `SELECT COUNT(*) FROM slash_requests ${whereClause}`
    const countResult = await pool.query(countQuery, params)
    const total = parseInt(countResult.rows[0].count, 10)

    // Get paginated data
    const dataQuery = `
      SELECT * FROM slash_requests
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `
    const dataResult = await pool.query(dataQuery, [...params, limit, offset])

    return {
      data: dataResult.rows.map((row) => this.mapRowToSlashRequest(row)),
      total,
      limit,
      offset,
    }
  }

  /**
   * Review a slash request (approve or reject)
   * 
   * @param input - Review input
   * @returns Updated slash request
   * @throws Error if validation fails or invalid status transition
   */
  async reviewSlashRequest(input: ReviewSlashRequestInput): Promise<SlashRequest> {
    // Get current request
    const current = await this.getSlashRequestById(input.id)
    if (!current) {
      throw new Error(`Slash request ${input.id} not found`)
    }

    // Validate status transition
    if (!isValidStatusTransition(current.status, input.status)) {
      throw new Error(getStatusTransitionError(current.status, input.status))
    }

    const pool = getPool()
    const query = `
      UPDATE slash_requests
      SET status = $1,
          reviewed_by = $2,
          reviewed_at = NOW(),
          review_notes = $3
      WHERE id = $4
      RETURNING *
    `

    try {
      const result = await pool.query(query, [
        input.status,
        input.reviewedBy,
        input.reviewNotes || null,
        input.id,
      ])

      return this.mapRowToSlashRequest(result.rows[0])
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to review slash request: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * Execute an approved slash request
   * 
   * @param input - Execution input
   * @returns Updated slash request
   * @throws Error if request is not approved or already executed
   */
  async executeSlashRequest(input: ExecuteSlashRequestInput): Promise<SlashRequest> {
    // Get current request
    const current = await this.getSlashRequestById(input.id)
    if (!current) {
      throw new Error(`Slash request ${input.id} not found`)
    }

    // Validate status transition
    if (!isValidStatusTransition(current.status, SlashStatus.EXECUTED)) {
      throw new Error(getStatusTransitionError(current.status, SlashStatus.EXECUTED))
    }

    if (!input.executionTxHash || input.executionTxHash.trim().length === 0) {
      throw new Error('Execution transaction hash is required')
    }

    const pool = getPool()
    const query = `
      UPDATE slash_requests
      SET status = $1,
          executed_at = NOW(),
          execution_tx_hash = $2
      WHERE id = $3
      RETURNING *
    `

    try {
      const result = await pool.query(query, [
        SlashStatus.EXECUTED,
        input.executionTxHash,
        input.id,
      ])

      return this.mapRowToSlashRequest(result.rows[0])
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to execute slash request: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * Map database row to SlashRequest object
   * 
   * @param row - Database row
   * @returns SlashRequest object
   */
  private mapRowToSlashRequest(row: any): SlashRequest {
    return {
      id: row.id,
      targetAddress: row.target_address,
      amount: row.amount,
      reason: row.reason,
      evidenceRef: row.evidence_ref,
      status: row.status as SlashStatus,
      submittedBy: row.submitted_by,
      submittedAt: new Date(row.submitted_at),
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : null,
      reviewNotes: row.review_notes,
      executedAt: row.executed_at ? new Date(row.executed_at) : null,
      executionTxHash: row.execution_tx_hash,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }
  }
}
