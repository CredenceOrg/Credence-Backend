import { MOCK_USERS, API_KEY_TO_USER, UserRole } from '../../middleware/auth.js'
import type { AuthenticatedRequest } from '../../middleware/auth.js'
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
  async listUsers(
    adminId: string,
    adminEmail: string,
    pagination: PaginationOptions = {},
    filters?: { role?: UserRole; active?: boolean }
  ): Promise<ListUsersResponse> {
    const page = pagination.page ?? 1
    const limit = pagination.limit ?? 50
    const offset = pagination.offset ?? 0

    const tenantId = MOCK_USERS[adminId]?.tenantId || 'tenant-admin'

    // Log the list action
    void this.auditLog.logAction({
      actorId: adminId,
      actorEmail: adminEmail,
      action: AuditAction.LIST_USERS,
      resourceType: 'admin_user',
      resourceId: adminId,
      details: { limit, offset, filters },
    })

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
      page,
      total,
      limit,
      hasNext: offset + paginated.length < total,
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
  async assignRole(
    adminId: string,
    adminEmail: string,
    request: AssignRoleRequest
  ): Promise<AssignRoleResponse> {
    const { userId, role } = request

    const tenantId = MOCK_USERS[adminId]?.tenantId || 'tenant-admin'

    // Validate role
    const validRoles = Object.values(UserRole)
    if (!validRoles.includes(role)) {
      void this.auditLog.logAction({
        actorId: adminId,
        actorEmail: adminEmail,
        action: AuditAction.ASSIGN_ROLE,
        resourceType: 'user',
        resourceId: userId,
        details: { requestedRole: role },
        status: 'failure',
        errorMessage: `Invalid role: ${role}`,
      })
      throw new Error(`Invalid role: ${role}`)
    }

    const user = MOCK_USERS[userId]
    if (!user) {
      void this.auditLog.logAction({
        actorId: adminId,
        actorEmail: adminEmail,
        action: AuditAction.ASSIGN_ROLE,
        resourceType: 'user',
        resourceId: userId,
        details: { requestedRole: role },
        status: 'failure',
        errorMessage: 'User not found',
      })
      throw new Error(`User not found: ${userId}`)
    }

    const oldRole = user.role
    user.role = role

    // Log the successful assignment
    await this.auditLog.logAction({
      actorId: adminId,
      actorEmail: adminEmail,
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: userId,
      details: { oldRole, newRole: role, targetUserEmail: user.email },
      status: 'success',
    })

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
  async revokeApiKey(
    adminId: string,
    adminEmail: string,
    request: RevokeApiKeyRequest
  ): Promise<RevokeApiKeyResponse> {
    const { userId, apiKey } = request

    const tenantId = MOCK_USERS[adminId]?.tenantId || 'tenant-admin'

    const user = MOCK_USERS[userId]
    if (!user) {
      void this.auditLog.logAction({
        actorId: adminId,
        actorEmail: adminEmail,
        action: AuditAction.REVOKE_API_KEY,
        resourceType: 'user',
        resourceId: userId,
        details: { revokedKey: apiKey },
        status: 'failure',
        errorMessage: 'User not found',
      })
      throw new Error(`User not found: ${userId}`)
    }

    if (user.apiKey !== apiKey) {
      void this.auditLog.logAction({
        actorId: adminId,
        actorEmail: adminEmail,
        action: AuditAction.REVOKE_API_KEY,
        resourceType: 'user',
        resourceId: userId,
        details: { revokedKey: apiKey, targetUserEmail: user.email },
        status: 'failure',
        errorMessage: 'API key does not belong to this user',
      })
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
    await this.auditLog.logAction({
      actorId: adminId,
      actorEmail: adminEmail,
      action: AuditAction.REVOKE_API_KEY,
      resourceType: 'user',
      resourceId: userId,
      details: { revokedKey: oldKey, newKey, targetUserEmail: user.email },
      status: 'success',
    })

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
    filters: any,
    limit: number,
    offset: number,
    user: AuthenticatedRequest['user']
  ) {
    return this.auditLog.getLogs(
      {
        ...filters,
        actorId: filters?.actorId ?? filters?.adminId,
        resourceId: filters?.resourceId ?? filters?.targetUserId,
      },
      limit,
      offset
    )
  }

  /**
   * Export audit logs as an NDJSON stream
   *
   * @param adminId - ID of the admin requesting the export
   * @param adminEmail - Email of the admin
   * @param startDate - Start date of the export range
   * @param endDate - End date of the export range
   * @returns AsyncGenerator yielding redacted AuditLogEntry objects
   */
  exportAuditLogs(
    adminId: string,
    adminEmail: string,
    startDate: Date,
    endDate: Date,
    user: AuthenticatedRequest['user']
  ) {
    const tenantId = user?.tenantId || 'tenant-admin'

    // Log the initiation of the export
    void this.auditLog.logAction({
      actorId: adminId,
      actorEmail: adminEmail,
      action: AuditAction.EXPORT_AUDIT_LOGS,
      resourceType: 'admin_user',
      resourceId: adminId,
      details: { startDate: startDate.toISOString(), endDate: endDate.toISOString(), phase: 'initiation' },
    })

    const options: { allowSuperScope?: boolean } = {}
    if (user?.role === UserRole.SUPER_ADMIN) {
      options.allowSuperScope = true
    }

    return this.auditLog.exportLogsStream(startDate, endDate, tenantId, options)
  }

  /**
   * Log the completion of an audit log export
   */
  logExportCompletion(
    adminId: string,
    adminEmail: string,
    startDate: Date,
    endDate: Date,
    recordCount: number
  ) {
    void this.auditLog.logAction({
      actorId: adminId,
      actorEmail: adminEmail,
      action: AuditAction.EXPORT_AUDIT_LOGS,
      resourceType: 'admin_user',
      resourceId: adminId,
      details: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        phase: 'completion',
        recordCount,
      },
    })
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

