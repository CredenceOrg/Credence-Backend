import { MOCK_USERS, API_KEY_TO_USER, UserRole } from '../../middleware/auth.js'
import { AuditLogService, AuditAction } from '../audit/index.js'
import type {
  AdminUser,
  AssignRoleRequest,
  AssignRoleResponse,
  RevokeApiKeyRequest,
  RevokeApiKeyResponse,
  ListUsersResponse,
  PaginationOptions,
} from './types.js'

/**
 * Admin service for managing users, roles, and API keys
 * Integrates with audit logging for compliance
 */
export class AdminService {
  private auditLog: AuditLogService

  constructor(auditLog: AuditLogService) {
    this.auditLog = auditLog
  }

  /**
   * List all users with pagination and filtering
   * 
   * @param adminId - ID of the admin requesting the list
   * @param adminEmail - Email of the admin
   * @param pagination - Pagination options
   * @param filters - Optional filters
   * @returns List of users and pagination info
   */
  listUsers(
    adminId: string,
    adminEmail: string,
    pagination: PaginationOptions = {},
    filters?: { role?: UserRole; active?: boolean }
  ): ListUsersResponse {
    const limit = pagination.limit ?? 50
    const offset = pagination.offset ?? 0

    // Log the list action
    this.auditLog.logAction(
      adminId,
      adminEmail,
      AuditAction.LIST_USERS,
      adminId,
      adminEmail,
      { limit, offset, filters }
    )

    // Get all users
    const users = Object.values(MOCK_USERS).map((user) => this.formatUser(user))

    // Apply filters if provided
    let filtered = users
    if (filters?.role) {
      filtered = filtered.filter((u) => u.role === filters.role)
    }
    if (filters?.active !== undefined) {
      filtered = filtered.filter((u) => u.active === filters.active)
    }

    // Paginate
    const total = filtered.length
    const paginated = filtered.slice(offset, offset + limit)

    return {
      users: paginated,
      total,
      limit,
      offset,
    }
  }

  /**
   * Assign a role to a user
   * 
   * @param adminId - ID of the admin performing the action
   * @param adminEmail - Email of the admin
   * @param request - Role assignment request
   * @returns Assignment response with updated user info
   * @throws Error if user not found or invalid role
   */
  assignRole(
    adminId: string,
    adminEmail: string,
    request: AssignRoleRequest
  ): AssignRoleResponse {
    const { userId, role } = request

    // Validate role
    const validRoles = Object.values(UserRole)
    if (!validRoles.includes(role)) {
      this.auditLog.logAction(
        adminId,
        adminEmail,
        AuditAction.ASSIGN_ROLE,
        userId,
        'unknown@credence.org',
        { requestedRole: role },
        'failure',
        `Invalid role: ${role}`
      )
      throw new Error(`Invalid role: ${role}`)
    }

    const user = MOCK_USERS[userId]
    if (!user) {
      this.auditLog.logAction(
        adminId,
        adminEmail,
        AuditAction.ASSIGN_ROLE,
        userId,
        'unknown@credence.org',
        { requestedRole: role },
        'failure',
        'User not found'
      )
      throw new Error(`User not found: ${userId}`)
    }

    const oldRole = user.role
    user.role = role

    // Log the successful assignment
    this.auditLog.logAction(
      adminId,
      adminEmail,
      AuditAction.ASSIGN_ROLE,
      userId,
      user.email,
      { oldRole, newRole: role },
      'success'
    )

    return {
      success: true,
      user: this.formatUser(user),
      message: `Role updated from ${oldRole} to ${role}`,
    }
  }

  /**
   * Revoke an API key for a user
   * 
   * @param adminId - ID of the admin performing the action
   * @param adminEmail - Email of the admin
   * @param request - Revoke request
   * @returns Revoke response
   * @throws Error if key not found or doesn't belong to user
   */
  revokeApiKey(
    adminId: string,
    adminEmail: string,
    request: RevokeApiKeyRequest
  ): RevokeApiKeyResponse {
    const { userId, apiKey } = request

    const user = MOCK_USERS[userId]
    if (!user) {
      this.auditLog.logAction(
        adminId,
        adminEmail,
        AuditAction.REVOKE_API_KEY,
        userId,
        'unknown@credence.org',
        { revokedKey: apiKey },
        'failure',
        'User not found'
      )
      throw new Error(`User not found: ${userId}`)
    }

    if (user.apiKey !== apiKey) {
      this.auditLog.logAction(
        adminId,
        adminEmail,
        AuditAction.REVOKE_API_KEY,
        userId,
        user.email,
        { revokedKey: apiKey },
        'failure',
        'API key does not belong to this user'
      )
      throw new Error('API key does not belong to this user')
    }

    // Generate new API key
    const oldKey = user.apiKey
    const newKey = this.generateApiKey()
    user.apiKey = newKey

    // Update the API key mapping
    delete API_KEY_TO_USER[oldKey]
    API_KEY_TO_USER[newKey] = userId

    // Log the successful revocation
    this.auditLog.logAction(
      adminId,
      adminEmail,
      AuditAction.REVOKE_API_KEY,
      userId,
      user.email,
      { revokedKey: oldKey, newKey },
      'success'
    )

    return {
      success: true,
      message: `API key revoked and replaced. New key issued.`,
    }
  }

  /**
   * Get audit logs with optional filtering
   * 
   * @param adminId - ID of the admin requesting logs
   * @param adminEmail - Email of the admin
   * @param filters - Filter options
   * @param limit - Max results
   * @param offset - Pagination offset
   * @returns Audit logs
   */
  getAuditLogs(
    adminId: string,
    adminEmail: string,
    filters?: any,
    limit?: number,
    offset?: number
  ) {
    return this.auditLog.getLogs(filters, limit, offset)
  }

  /**
   * Format user for response (excludes internal details)
   */
  private formatUser(user: any): AdminUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      apiKey: user.apiKey,
      createdAt: new Date(Date.now() - 86400000 * 30).toISOString(), // Mock: 30 days ago
      lastActivity: new Date().toISOString(),
      active: true,
    }
  }

  /**
   * Generate a new API key
   */
  private generateApiKey(): string {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 15)
    return `api_${timestamp}_${random}`
  }
}
