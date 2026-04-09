import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryAuditLogsRepository, PostgresAuditLogsRepository } from './auditLogsRepository.js'
import { AuditAction } from '../../services/audit/index.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('InMemoryAuditLogsRepository', () => {
  let repository: InMemoryAuditLogsRepository

  beforeEach(() => {
    repository = new InMemoryAuditLogsRepository()
  })

  it('appends immutable entries', async () => {
    const entry = await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      details: { oldRole: 'user', newRole: 'admin' },
    })

    entry.details.oldRole = 'tampered'

    const all = await repository.getAll()
    expect(all[0].details.oldRole).toBe('user')
  })

  it('queries by actor and resource', async () => {
    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin1@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-a',
    })
    await repository.append({
      actorId: 'admin-2',
      actorEmail: 'admin2@credence.org',
      action: AuditAction.REVOKE_API_KEY,
      resourceType: 'user',
      resourceId: 'user-b',
    })

    const byActor = await repository.query({ actorId: 'admin-1' }, 50, 0)
    expect(byActor.total).toBe(1)
    expect(byActor.logs[0].actorId).toBe('admin-1')

    const byResource = await repository.query({ resourceId: 'user-b' }, 50, 0)
    expect(byResource.total).toBe(1)
    expect(byResource.logs[0].resourceId).toBe('user-b')
  })

  it('queries by time range and paginates', async () => {
    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.LIST_USERS,
      resourceType: 'admin_user',
      resourceId: 'admin-1',
    })

    await delay(5)

    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.REVOKE_API_KEY,
      resourceType: 'user',
      resourceId: 'user-1',
    })

    await delay(5)

    const current = new Date().toISOString()

    await delay(5)

    await repository.append({
      actorId: 'admin-2',
      actorEmail: 'admin2@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-2',
    })

    const range = await repository.query({ from: current }, 10, 0)
    expect(range.total).toBe(1)
    expect(range.logs[0].resourceId).toBe('user-2')

    const paged = await repository.query(undefined, 1, 1)
    expect(paged.logs).toHaveLength(1)
    expect(paged.total).toBe(3)

    const byAdminAlias = await repository.query({ adminId: 'admin-2' }, 10, 0)
    expect(byAdminAlias.total).toBe(1)

    const byTargetAlias = await repository.query({ targetUserId: 'user-1' }, 10, 0)
    expect(byTargetAlias.total).toBe(1)

    const byStatus = await repository.query({ status: 'success' }, 10, 0)
    expect(byStatus.total).toBe(3)

    const byResourceType = await repository.query({ resourceType: 'user' }, 10, 0)
    expect(byResourceType.total).toBe(2)
  })
})

describe('PostgresAuditLogsRepository', () => {
  it('appends, queries and clears audit logs', async () => {
    const appendOccurredAt = new Date('2024-01-01T00:00:00.000Z')
    const queryOccurredAt = new Date('2024-01-02T00:00:00.000Z')
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'append-id',
              occurred_at: appendOccurredAt,
              actor_id: 'admin-1',
              actor_email: 'admin@credence.org',
              action: AuditAction.ASSIGN_ROLE,
              resource_type: 'user',
              resource_id: 'user-1',
              details_json: { reason: 'test append' },
              status: 'success',
              ip_address: '127.0.0.1',
              error_message: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'query-id',
              occurred_at: queryOccurredAt,
              actor_id: 'admin-2',
              actor_email: 'admin2@credence.org',
              action: AuditAction.REVOKE_API_KEY,
              resource_type: 'user',
              resource_id: 'user-2',
              details_json: { reason: 'test query' },
              status: 'failure',
              ip_address: null,
              error_message: 'conflict',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    }

    const repository = new PostgresAuditLogsRepository(db as any)

    const created = await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      details: { reason: 'test append' },
      status: 'success',
      ipAddress: '127.0.0.1',
    })

    expect(created.id).toBe('append-id')
    expect(created.timestamp).toBe(appendOccurredAt.toISOString())

    const result = await repository.query(
      {
        action: AuditAction.REVOKE_API_KEY,
        actorId: 'admin-2',
        resourceId: 'user-2',
        resourceType: 'user',
        status: 'failure',
        from: '2024-01-01T00:00:00.000Z',
        to: '2024-12-31T23:59:59.000Z',
      },
      10,
      0,
    )

    expect(result.total).toBe(1)
    expect(result.logs[0].id).toBe('query-id')
    expect(result.logs[0].errorMessage).toBe('conflict')

    await repository.clear()

    expect(db.query).toHaveBeenCalledTimes(4)
    expect(String(db.query.mock.calls[3][0])).toContain('DELETE FROM audit_logs')
  })

  it('supports actor/resource aliases in filters', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] }),
    }

    const repository = new PostgresAuditLogsRepository(db as any)
    await repository.query({ adminId: 'admin-7', targetUserId: 'user-9' }, 5, 2)

    const countSql = String(db.query.mock.calls[0][0])
    const selectSql = String(db.query.mock.calls[1][0])
    const countParams = db.query.mock.calls[0][1]
    const selectParams = db.query.mock.calls[1][1]

    expect(countSql).toContain('actor_id = $1')
    expect(countSql).toContain('resource_id = $2')
    expect(selectSql).toContain('LIMIT $3')
    expect(selectSql).toContain('OFFSET $4')
    expect(countParams.slice(0, 2)).toEqual(['admin-7', 'user-9'])
    expect(selectParams).toEqual(['admin-7', 'user-9', 5, 2])
  })
})
