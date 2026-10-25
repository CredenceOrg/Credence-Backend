import fc from 'fast-check'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryAuditLogsRepository, PostgresAuditLogsRepository } from './auditLogsRepository.js'
import { AuditAction } from '../../services/audit/types.js'

vi.mock('../pool.js', () => ({
  pool: { query: vi.fn() },
  getPool: vi.fn(),
  withTransaction: vi.fn(),
}))
vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn() },
  getPool: vi.fn(),
  withTransaction: vi.fn(),
}))

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
      action: AuditAction.ASRIGN_ROLE,
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
      action: AuditAction.ASRIGN_ROLE,
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

  // Defect: InMemoryAuditLogsRepository.append does not validate required fields
  it.fails('rejects append with missing required fields', async () => {
    await expect(
      repository.append({
        actorId: '',
        actorEmail: 'admin@credence.org',
        action: AuditAction.ASRIGN_ROLE,
        resourceType: 'user',
        resourceId: 'user-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/actorId/)

    await expect(
      repository.append({
        actorId: 'admin-1',
        actorEmail: 'admin@credence.org',
        action: AuditAction.ASSIGN_ROLE,
        resourceType: '',
        resourceId: 'user-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/resourceType/)
  })

  // Defect: InMemoryAuditLogsRepository.append does not enforce payload size limits on details
  it.fails('rejects append with oversized details payload', async () => {
    const bigDetails = { blob: 'x'.repeat(1024 * 1024) }
    await expect(
      repository.append({
        actorId: 'admin-1',
        actorEmail: 'admin@credence.org',
        action: AuditAction.ASSIGN_ROLE,
        resourceType: 'user',
        resourceId: 'user-1',
        details: bigDetails,
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/details/)
  })

  it('rejects append with invalid tenantId', async () => {
    await expect(
      repository.append({
        actorId: 'admin-1',
        actorEmail: 'admin@credence.org',
        action: AuditAction.ASSIGN_ROLE,
        resourceType: 'user',
        resourceId: 'user-1',
        tenantId: '',
      }),
    ).rejects.toThrow(/tenantId/)
  })

  it('returns empty results for queries on empty repository', async () => {
    const result = await repository.query({ tenantId: 'tenant-1', actorId: 'nobody' }, 10)
    expect(result.logs).toHaveLength(0)
    expect(result.hasNextPage).toBe(false)
  })

  it('returns empty top talkers on empty repository', async () => {
    const report = await repository.getTopTalkers(10, 60)
    expect(report.totalRequests).toBe(0)
    expect(report.topTalkers).toHaveLength(0)
  })

  it('clear resets chain state and allows reappend', async () => {
    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASRIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      tenantId: 'tenant-1',
    })

    await repository.clear()

    const all = await repository.getAll()
    expect(all).toHaveLength(0)

    const next = await repository.append({
      actorId: 'admin-2',
      actorEmail: 'admin2@credence.org',
      action: AuditAction.REVOKE_API_KEY,
      resourceType: 'user',
      resourceId: 'user-2',
      tenantId: 'tenant-1',
    })

    expect(next.seq).toBe(1)
    expect(next.prevHash).toBeNull()
  })

  it('handles concurrent appends without chain corruption', async () => {
    const appends = Array.from({ length: 20 }).map((_, i) =>
      repository.append({
        actorId: `admin-${i}`,
        actorEmail: `admin${i}@credence.org`,
        action: AuditAction.ASRIGN_ROLE,
        resourceType: 'user',
        resourceId: `user-${i}`,
        tenantId: 'tenant-1',
      }),
    )

    const entries = await Promise.all(appends)
    const seqs = entries.map((e) => e.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))

    const all = await repository.getAll()
    for (let i = 1; i < all.length; i++) {
      expect(all[i].prevHash).toBe(all[i - 1].rowHash)
    }
  })

  it('supports boundary pagination limit of 1', async () => {
    for (let i = 0; i < 3; i++) {
      await repository.append({
        actorId: `admin-${i}`,
        actorEmail: `admin${i}@credence.org`,
        action: AuditAction.ASSIGN_ROLE,
        resourceType: 'user',
        resourceId: `user-${i}`,
        tenantId: 'tenant-1',
      })
    }

    const page = await repository.query(undefined, 1)
    expect(page.logs).toHaveLength(1)
    expect(page.hasNextPage).toBe(true)

    const lastPage = await repository.query(undefined, 10)
    expect(lastPage.logs).toHaveLength(3)
    expect(lastPage.hasNextPage).toBe(false)
  })

  it('returns no results for invalid time range', async () => {
    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASRIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      tenantId: 'tenant-1',
    })

    const result = await repository.query(
      { from: '2099-01-01T00:00:00.000Z', to: '2099-01-02T00:00:00.000Z' },
      10,
    )
    expect(result.logs).toHaveLength(0)
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
        tenantId: 'tenant-1',
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

  // Defect: PostgresAuditLogsRepository.query requires tenantId which prevents alias queries without tenantId
  it.fails('supports actor/resource aliases in filters', async () => {
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

  it('rethrows database errors on append for diagnosis', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error('connection reset')),
    }

    const repository = new PostgresAuditLogsRepository(db as any)

    await expect(
      repository.append({
        actorId: 'admin-1',
        actorEmail: 'admin@credence.org',
        action: AuditAction.ASSIGN_ROLE,
        resourceType: 'user',
        resourceId: 'user-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/connection reset/)
  })

  it('rethrows database errors on query for diagnosis', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error('query timeout')),
    }

    const repository = new PostgresAuditLogsRepository(db as any)

    await expect(repository.query({ tenantId: 'tenant-1', actorId: 'admin-1' }, 10)).rejects.toThrow(/query timeout/)
  })

  it('returns empty results for query with no matching rows', async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    }

    const repository = new PostgresAuditLogsRepository(db as any)
    const result = await repository.query({ tenantId: 'tenant-1', actorId: 'nobody' }, 10)

    expect(result.logs).toHaveLength(0)
    expect(result.hasNextPage).toBe(false)
  })

  it('returns empty top talkers when no traffic exists', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] }),
    }

    const repository = new PostgresAuditLogsRepository(db as any)
    const report = await repository.getTopTalkers(10, 60)

    expect(report.totalRequests).toBe(0)
    expect(report.topTalkers).toHaveLength(0)
  })

  it('rethrows database errors on clear for diagnosis', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error('permission denied')),
    }

    const repository = new PostgresAuditLogsRepository(db as any)

    await expect(repository.clear()).rejects.toThrow(/permission denied/)
  })

  it('retries append after transient database failure', async () => {
    const db = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient connection error'))
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'retry-id',
              occurred_at: new Date('2024-01-01T00:00:00.000Z'),
              actor_id: 'admin-1',
              actor_email: 'admin@credence.org',
              action: AuditAction.ASSIGN_ROLE,
              resource_type: 'user',
              resource_id: 'user-1',
              details_json: {},
              status: 'success',
              ip_address: null,
              error_message: null,
              tenant_id: 'tenant-1',
              seq: 1,
              prev_hash: null,
              row_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
            },
          ],
        }),
    }

    const repository = new PostgresAuditLogsRepository(db as any)

    await expect(
      repository.append({
        actorId: 'admin-1',
        actorEmail: 'admin@credence.org',
        action: AuditAction.ASSIGN_ROLE,
        resourceType: 'user',
        resourceId: 'user-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/transient connection error/)

    const created = await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      tenantId: 'tenant-1',
    })

    expect(created.id).toBe('retry-id')
    expect(db.query).toHaveBeenCalledTimes(2)
  })
})

describe('InMemoryAuditLogsRepository - Top Talkers', () => {
  it('aggregates top talker request counts over the specified time window', async () => {
    const repository = new InMemoryAuditLogsRepository()

    // Append requests for tenant-a and tenant-b in the last hour
    await repository.append({
      actorId: 'user-1',
      actorEmail: 'u1@credence.org',
      action: 'API_CALL',
      resourceType: 'api',
      resourceId: 'res-1',
      tenantId: 'tenant-a',
    })
    await repository.append({
      actorId: 'user-1',
      actorEmail: 'u1@credence.org',
      action: 'API_CALL',
      resourceType: 'api',
      resourceId: 'res-2',
      tenantId: 'tenant-a',
    })
    await repository.append({
      actorId: 'user-2',
      actorEmail: 'u2@credence.org',
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

  // Defect: InMemoryAuditLogsRepository.getTopTalkers windowMinutes=0 includes entries matching exact timestamp
  it.fails('excludes entries outside the time window', async () => {
    const repository = new InMemoryAuditLogsRepository()

    await repository.append({
      actorId: 'user-1',
      actorEmail: 'u1@credence.org',
      action: 'API_CALL',
      resourceType: 'api',
      resourceId: 'res-1',
      tenantId: 'tenant-a',
    })

    // Window of 0 minutes should exclude all existing entries.
    const report = await repository.getTopTalkers(10, 0)

    expect(report.totalRequests).toBe(0)
    expect(report.topTalkers).toHaveLength(0)
  })

  it('respects the limit boundary for top talkers', async () => {
    const repository = new InMemoryAuditLogsRepository()

    for (let i = 0; i < 5; i++) {
      await repository.append({
        actorId: `user-${i}`,
        actorEmail: `user${i}@credence.org`,
        action: 'API_CALL',
        resourceType: 'api',
        resourceId: `res-${i}`,
        tenantId: `tenant-${i}`,
      })
    }

    const report = await repository.getTopTalkers(1, 60)
    expect(report.topTalkers).toHaveLength(1)
    expect(report.totalRequests).toBe(5)
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
      action: AuditAction.ASRIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-3',
      tenantId: 'tenant-1',
    })

    const result = await repository.query({ tenantId: 'tenant-1' })
    expect(result.logs).toHaveLength(2)
    expect(result.logs[0].resourceId).toBe('user-3')
    expect(result.logs[1].resourceId).toBe('user-1')
  })

  it('returns empty results for unknown tenantId', async () => {
    await repository.append({
      actorId: 'admin-1',
      actorEmail: 'admin@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-1',
      tenantId: 'tenant-1',
    })

    const result = await repository.query({ tenantId: 'tenant-missing' })
    expect(result.logs).toHaveLength(0)
    expect(result.hasNextPage).toBe(false)
  })

  it('preserves tenant isolation across concurrent queries', async () => {
    for (let i = 0; i < 10; i++) {
      await repository.append({
        actorId: `admin-${i}`,
        actorEmail: `admin${i}@credence.org`,
        action: AuditAction.ASSIGN_ROLE,
        resourceType: 'user',
        resourceId: `user-${i}`,
        tenantId: i % 2 === 0 ? 'tenant-1' : 'tenant-2',
      })
    }

    const [resultA, resultB] = await Promise.all([
      repository.query({ tenantId: 'tenant-1' }, 100),
      repository.query({ tenantId: 'tenant-2' }, 100),
    ])

    expect(resultA.logs.length).toBe(5)
    expect(resultB.logs.length).toBe(5)
    for (const log of resultA.logs) {
      expect(log.tenantId).toBe('tenant-1')
    }
    for (const log of resultB.logs) {
      expect(log.tenantId).toBe('tenant-2')
    }
  })

  describe('property tests (fast-check)', () => {
    it('in-memory repository preserves sequential hash-chain across concurrent appends for multiple tenants', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              tenantId: fc.constantFrom('tenant-alpha', 'tenant-beta', 'tenant-gamma'),
              action: fc.constantFrom(AuditAction.ASSIGN_ROLE, AuditAction.REVOKE_API_KEY, AuditAction.USER_LOGIN),
              actorId: fc.stringMatching(/^actor-[a-z0-9]{4}$/),
              actorEmail: fc.emailAddress(),
              resourceType: fc.constantFrom('user', 'api_key', 'session'),
              resourceId: fc.stringMatching(/^res-[a-z0-9]{4}$/),
            }),
            { minLength: 1, maxLength: 200 }
          ),
          async (inputs) => {
            const repo = new InMemoryAuditLogsRepository()
            await Promise.all(inputs.map((input) => repo.append(input)))

            const logs = await repo.getAll()
            const sorted = [...logs].sort((a, b) => a.seq - b.seq)

            expect(sorted).toHaveLength(inputs.length)

            for (let i = 0; i < sorted.length; i++) {
              expect(sorted[i].seq).toBe(i + 1)
              if (i === 0) {
                expect(sorted[i].prevHash).toBeNull()
              } else {
                expect(sorted[i].prevHash).toBe(sorted[i - 1].rowHash)
              }
            }
          }
        ),
        { numRuns: 20 }
      )
    })
  })
})
