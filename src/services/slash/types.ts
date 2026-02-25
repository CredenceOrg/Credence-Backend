/**
 * Slash request status enum
 */
export enum SlashStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXECUTED = 'executed',
}

/**
 * User role enum for authorization
 */
export enum UserRole {
  VERIFIER = 'verifier',
  ADMIN = 'admin',
  USER = 'user',
}

/**
 * Slash request entity
 */
export interface SlashRequest {
  id: string
  targetAddress: string
  amount: string
  reason: string
  evidenceRef: string
  status: SlashStatus
  submittedBy: string
  submittedAt: Date
  reviewedBy: string | null
  reviewedAt: Date | null
  reviewNotes: string | null
  executedAt: Date | null
  executionTxHash: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Input for creating a new slash request
 */
export interface CreateSlashRequestInput {
  targetAddress: string
  amount: string
  reason: string
  evidenceRef: string
  submittedBy: string
}

/**
 * Input for reviewing a slash request
 */
export interface ReviewSlashRequestInput {
  id: string
  status: SlashStatus.APPROVED | SlashStatus.REJECTED
  reviewedBy: string
  reviewNotes?: string
}

/**
 * Input for executing a slash request
 */
export interface ExecuteSlashRequestInput {
  id: string
  executionTxHash: string
}

/**
 * Query filters for listing slash requests
 */
export interface SlashRequestFilters {
  status?: SlashStatus
  targetAddress?: string
  submittedBy?: string
  limit?: number
  offset?: number
}

/**
 * Paginated list response
 */
export interface PaginatedSlashRequests {
  data: SlashRequest[]
  total: number
  limit: number
  offset: number
}

/**
 * Validation error
 */
export interface ValidationError {
  field: string
  message: string
}
