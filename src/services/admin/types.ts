import { UserRole } from '../../middleware/auth.js'

/**
 * User information for admin management
 */
export interface AdminUser {
  id: string
  email: string
  role: UserRole
  apiKey: string
  createdAt: string
  lastActivity: string | null
  active: boolean
}

/**
 * Request body for assigning a role
 */
export interface AssignRoleRequest {
  userId: string
  role: UserRole
}

/**
 * Request body for revoking an API key
 */
export interface RevokeApiKeyRequest {
  userId: string
  apiKey: string
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  limit?: number
  offset?: number
}

/**
 * List users response with pagination
 */
export interface ListUsersResponse {
  users: AdminUser[]
  total: number
  limit: number
  offset: number
}

/**
 * Assign role response
 */
export interface AssignRoleResponse {
  success: boolean
  user: AdminUser
  message: string
}

/**
 * Revoke API key response
 */
export interface RevokeApiKeyResponse {
  success: boolean
  message: string
}
