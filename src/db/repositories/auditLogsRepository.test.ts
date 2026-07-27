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
      tenantId: 'tenant-1',
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
      tenantId: 'tenant-1',
    })
    await repository.append({
      actorId: 'admin-2',
      actorEmail: 'admin2@credence.org',
      action: AuditAction.REVOKE_API_KEY,
      resourceType: 'user',
      resourceId: 'user-b',
      tenantId: 'tenant-2',
    })

    const byActor = await repository.query({ actorId: 'admin-1' }, 50)
    expect(byActor.logs.length).toBe(1)
    expect(byActor.logs[0].actorId).toBe('admin-1')

    const byResource = await repository.query({ resourceId: 'user-b' }, 50)
    expect(byResource.logs.length).toBe(1)
    expect(byResource.logs[0].resourceId).toBe('user-b')
  })

  it('queries by time range and paginates', async () => {
    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.LIST_USERS,
      resourceType: 'admin_user',
      resourceId: 'admin-1',
      tenantId: 'tenant-1',
    })

    await delay(5)

    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.REVOKE_API_KEY,
      resourceType: 'user',
      resourceId: 'user-1',
      tenantId: 'tenant-1',
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
      tenantId: 'tenant-1',
    })

    const range = await repository.query({ from: current }, 10)
    expect(range.logs.length).toBe(1)
    expect(range.logs[0].resourceId).toBe('user-2')

    const paged = await repository.query(undefined, 1)
    expect(paged.logs).toHaveLength(1)
    expect(paged.hasNextPage).toBe(true)

    const all = await repository.getAll()
    expect(all.length).toBe(3)

    const byAdminAlias = await repository.query({ adminId: 'admin-2' }, 10)
    expect(byAdminAlias.logs.length).toBe(1)

    const byTargetAlias = await repository.query({ targetUserId: 'user-1' }, 10)
    expect(byTargetAlias.logs.length).toBe(1)

    const byStatus = await repository.query({ status: 'success' }, 10)
    expect(byStatus.logs.length).toBe(3)

    const byResourceType = await repository.query({ resourceType: 'user' }, 10)
    expect(byResourceType.logs.length).toBe(2)
  })

  it('includes hash chain fields in appended entries', async () => {
    const entry = await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      tenantId: 'tenant-1',
    })

    expect(entry.seq).toBe(1)
    expect(entry.prevHash).toBeNull()
    expect(entry.rowHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('chains prevHash correctly', async () => {
    const first = await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      tenantId: 'tenant-1',
    })

    const second = await repository.append({
      actorId: 'admin-2',
      actorEmail: 'admin2@credence.org',
      action: AuditAction.REVOKE_API_KEY,
      resourceType: 'user',
      resourceId: 'user-2',
      tenantId: 'tenant-1',
    })

    expect(second.prevHash).toBe(first.rowHash)
    expect(second.seq).toBe(2)
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
              tenant_id: 'tenant-1',
              seq: 1,
              prev_hash: null,
              row_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
            },
          ],
        })
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
              tenant_id: 'tenant-1',
              seq: 2,
              prev_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
              row_hash: 'def789ghi012def789ghi012def789ghi012def789ghi012def789ghi012defg',
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
      tenantId: 'tenant-1',
    })

    expect(created.id).toBe('append-id')
    expect(created.timestamp).toBe(appendOccurredAt.toISOString())
    expect(created.prevHash).toBeNull()
    expect(created.rowHash).toBeTruthy()

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
    )

    expect(result.logs.length).toBe(1)
    expect(result.logs[0].id).toBe('query-id')
    expect(result.logs[0].errorMessage).toBe('conflict')

    await repository.clear()

    expect(db.query).toHaveBeenCalledTimes(3)
    expect(String(db.query.mock.calls[2][0])).toContain('DELETE FROM audit_logs')
  })

  it('supports actor/resource aliases in filters', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }),
    }

    const repository = new PostgresAuditLogsRepository(db as any)
    await repository.query({ adminId: 'admin-7', targetUserId: 'user-9' }, 5)

    const selectSql = String(db.query.mock.calls[0][0])
    const selectParams = db.query.mock.calls[0][1]

    expect(selectSql).toContain('actor_id = $1')
    expect(selectSql).toContain('resource_id = $2')
    expect(selectSql).toContain('LIMIT $3')
    expect(selectParams).toEqual(['admin-7', 'user-9', 6]) // limit + 1 for hasNextPage detection
  })

  it('queries top talkers report for PostgresAuditLogsRepository', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ total: 10 }] })
        .mockResolvedValueOnce({
          rows: [
            { tenant_id: 'tenant-a', request_count: 7, last_request_at: new Date() },
            { tenant_id: 'tenant-b', request_count: 3, last_request_at: new Date() },
          ],
        }),
    }

    const repository = new PostgresAuditLogsRepository(db as any)
    const report = await repository.getTopTalkers(5, 60, new Date('2026-07-24T18:00:00.000Z'))

    expect(report.totalRequests).toBe(10)
    expect(report.topTalkers).toHaveLength(2)
    expect(report.topTalkers[0].tenantId).toBe('tenant-a')
    expect(report.topTalkers[0].requestCount).toBe(7)
    expect(report.topTalkers[0].percentage).toBe(70)
    expect(report.topTalkers[1].tenantId).toBe('tenant-b')
    expect(report.topTalkers[1].requestCount).toBe(3)
    expect(report.topTalkers[1].percentage).toBe(30)
  })
})

describe('InMemoryAuditLogsRepository - Top Talkers', () => {
  it('aggregates top talker request counts over the specified time window', async () => {
    const repository = new InMemoryAuditLogsRepository()

    // Append requests for tenant-a and tenant-b in the last hour
    await repository.append({
      actorId: 'user-1',
      actorEmail: 'u1@test.com',
      action: 'API_CALL',
      resourceType: 'api',
      resourceId: 'res-1',
      tenantId: 'tenant-a',
    })
    await repository.append({
      actorId: 'user-1',
      actorEmail: 'u1@test.com',
      action: 'API_CALL',
      resourceType: 'api',
      resourceId: 'res-2',
      tenantId: 'tenant-a',
    })
    await repository.append({
      actorId: 'user-2',
      actorEmail: 'u2@test.com',
      action: 'API_CALL',
      resourceType: 'api',
      resourceId: 'res-3',
      tenantId: 'tenant-b',
    })

    const report = await repository.getTopTalkers(10, 60)

    expect(report.totalRequests).toBe(3)
    expect(report.topTalkers).toHaveLength(2)
    expect(report.topTalkers[0].tenantId).toBe('tenant-a')
    expect(report.topTalkers[0].requestCount).toBe(2)
    expect(report.topTalkers[0].percentage).toBe(66.67)
    expect(report.topTalkers[1].tenantId).toBe('tenant-b')
    expect(report.topTalkers[1].requestCount).toBe(1)
    expect(report.topTalkers[1].percentage).toBe(33.33)
  })
})

describe('Audit Log Index and Scoping Behavior', () => {
  let repository: InMemoryAuditLogsRepository

  beforeEach(() => {
    repository = new InMemoryAuditLogsRepository()
  })

  it('happy path: queries and filters by tenantId ordered by occurred_at DESC', async () => {
    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      tenantId: 'tenant-1',
    })

    await delay(5)

    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.REVOKE_API_KEY,
      resourceType: 'user',
      resourceId: 'user-2',
      tenantId: 'tenant-2',
    })

    await delay(5)

    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-3',
      tenantId: 'tenant-1',
    })

    const result = await repository.query({ tenantId: 'tenant-1' })
    expect(result.logs).toHaveLength(2)
    expect(result.logs[0].resourceId).toBe('user-3')
    expect(result.logs[1].resourceId).toBe('user-1')
    expect(result.logs.every(log => log.tenantId === 'tenant-1')).toBe(true)
  })

  it('explicit failure mode: fails to paginate when cursor is invalid or malformed', async () => {
    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      tenantId: 'tenant-1',
    })

    const result = await repository.query({ tenantId: 'tenant-1' }, 10, 'garbage-cursor')
    expect(result.logs).toHaveLength(1)
    expect(result.logs[0].resourceId).toBe('user-1')
  })
})

describe('PostgresAuditLogsRepository - Index Querying and Scoping', () => {
  it('happy path: generates query with correct ORDER BY and WHERE clauses', async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    }
    const repository = new PostgresAuditLogsRepository(db as any)
    
    await repository.query({ tenantId: 'tenant-123' }, 20)

    expect(db.query).toHaveBeenCalled()
    const sql = String(db.query.mock.calls[0][0])
    const params = db.query.mock.calls[0][1]

    expect(sql).toContain('WHERE tenant_id = $1')
    expect(sql).toContain('ORDER BY occurred_at DESC, id DESC')
    expect(params).toEqual(['tenant-123', 21])
  })

  it('explicit failure mode: validation or handling of invalid query parameters', async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    }
    const repository = new PostgresAuditLogsRepository(db as any)
    
    await repository.query({ tenantId: 'tenant-123' }, 20, 'invalid-non-base64-cursor!')
    
    expect(db.query).toHaveBeenCalled()
    const sql = String(db.query.mock.calls[0][0])
    expect(sql).not.toContain('occurred_at, id')
  })
})

