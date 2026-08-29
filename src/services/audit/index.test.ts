import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditLogService, AuditAction } from './index.js'
import { InMemoryAuditLogsRepository } from '../../db/repositories/auditLogsRepository.js'
import { logger } from '../../utils/logger.js'

describe('AuditLogService audit log lines', () => {
  let service: AuditLogService

  beforeEach(() => {
    vi.restoreAllMocks()
    service = new AuditLogService(new InMemoryAuditLogsRepository())
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
  })

  it('emits an INFO log line carrying tenantId on a successful audit action', async () => {
    await service.logAction(
      'tenant-happy-path',
      'admin-1',
      'admin@example.com',
      AuditAction.ASSIGN_ROLE,
      'user-2',
      'user@example.com',
      { role: 'reviewer' },
      'success',
    )

    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()

    const [loggedPayload] = vi.mocked(logger.info).mock.calls[0]
    expect(loggedPayload).toMatchObject({
      tenantId: 'tenant-happy-path',
      action: AuditAction.ASSIGN_ROLE,
      status: 'success',
    })
  })

  it('emits a WARN log line carrying tenantId when the audit action failed', async () => {
    await service.logAction(
      'tenant-failure-path',
      'admin-1',
      'admin@example.com',
      AuditAction.REVOKE_API_KEY,
      'user-3',
      undefined,
      undefined,
      'failure',
      'target key not found',
    )

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.info).not.toHaveBeenCalled()

    const [loggedPayload] = vi.mocked(logger.warn).mock.calls[0]
    expect(loggedPayload).toMatchObject({
      tenantId: 'tenant-failure-path',
      action: AuditAction.REVOKE_API_KEY,
      status: 'failure',
    })
  })

  it('never leaks actor/target email addresses into the audit log line', async () => {
    await service.logAction(
      'tenant-redaction-check',
      'admin-1',
      'admin@example.com',
      AuditAction.DELETE_USER,
      'user-4',
      'target@example.com',
      { note: 'cleanup' },
      'success',
    )

    const [loggedPayload] = vi.mocked(logger.info).mock.calls[0]
    expect(loggedPayload).not.toHaveProperty('actorEmail')
    expect(loggedPayload).not.toHaveProperty('targetUserEmail')
    expect(loggedPayload).not.toHaveProperty('details')
    expect(JSON.stringify(loggedPayload)).not.toContain('example.com')
  })
})
