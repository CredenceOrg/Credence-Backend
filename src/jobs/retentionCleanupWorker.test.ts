import { describe, it, expect, beforeEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { OrganizationRepository } from '../db/repositories/organizationRepository.js'
import { RetentionPolicyRepository } from '../db/repositories/retentionPolicyRepository.js'
import { RetentionRecordRepository } from '../db/repositories/retentionRecordRepository.js'
import { RetentionCleanupWorker } from './retentionCleanupWorker.js'

async function buildTestPool(): Promise<Pool> {
  const db = newDb()
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => crypto.randomUUID(),
  } as Parameters<typeof db.public.registerFunction>[0])

  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  await pool.query(`
    CREATE TABLE organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE retention_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      scope_key TEXT NOT NULL,
      record_class TEXT NOT NULL CHECK (record_class IN ('event', 'audit')),
      retention_days INTEGER NOT NULL CHECK (retention_days > 0),
      disposition TEXT NOT NULL CHECK (disposition IN ('archive', 'delete')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE UNIQUE INDEX retention_policies_scope_key_record_class_idx
      ON retention_policies (scope_key, record_class)
  `)
  await pool.query(`
    CREATE TABLE retention_policy_changes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      record_class TEXT NOT NULL CHECK (record_class IN ('event', 'audit')),
      previous_retention_days INTEGER,
      previous_disposition TEXT,
      new_retention_days INTEGER NOT NULL CHECK (new_retention_days > 0),
      new_disposition TEXT NOT NULL CHECK (new_disposition IN ('archive', 'delete')),
      changed_by TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE organization_event_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      event_name TEXT NOT NULL,
      payload TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE organization_event_record_archives (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      event_name TEXT NOT NULL,
      payload TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE organization_audit_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  return pool
}

describe('RetentionCleanupWorker', () => {
  let pool: Pool
  let organizations: OrganizationRepository
  let policies: RetentionPolicyRepository
  let records: RetentionRecordRepository
  let worker: RetentionCleanupWorker

  beforeEach(async () => {
    pool = await buildTestPool()
    organizations = new OrganizationRepository(pool)
    policies = new RetentionPolicyRepository(pool)
    records = new RetentionRecordRepository(pool)
    worker = new RetentionCleanupWorker(organizations, policies, records, {
      eventBatchSize: 2,
      auditBatchSize: 2,
      maxBatchesPerClass: 5,
    })
  })

  it('archives old event records and deletes old audit records using resolved policies', async () => {
    const now = new Date('2026-03-26T00:00:00.000Z')
    const org = await organizations.create('Retention Org')

    await policies.upsertPolicy({
      recordClass: 'event',
      retentionDays: 90,
      disposition: 'archive',
      changedBy: 'system',
    })
    await policies.upsertPolicy({
      recordClass: 'audit',
      retentionDays: 365,
      disposition: 'delete',
      changedBy: 'system',
    })
    await policies.upsertPolicy({
      organizationId: org.id,
      recordClass: 'event',
      retentionDays: 30,
      disposition: 'archive',
      changedBy: 'admin-1',
    })
    await policies.upsertPolicy({
      organizationId: org.id,
      recordClass: 'audit',
      retentionDays: 60,
      disposition: 'delete',
      changedBy: 'admin-1',
    })

    await records.createEventRecord({
      organizationId: org.id,
      eventName: 'old-event-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    await records.createEventRecord({
      organizationId: org.id,
      eventName: 'old-event-2',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    })
    await records.createEventRecord({
      organizationId: org.id,
      eventName: 'new-event',
      createdAt: new Date('2026-03-20T00:00:00.000Z'),
    })

    await records.createAuditRecord({
      organizationId: org.id,
      actorId: 'actor-1',
      action: 'old-audit-1',
      createdAt: new Date('2025-12-01T00:00:00.000Z'),
    })
    await records.createAuditRecord({
      organizationId: org.id,
      actorId: 'actor-2',
      action: 'old-audit-2',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    await records.createAuditRecord({
      organizationId: org.id,
      actorId: 'actor-3',
      action: 'new-audit',
      createdAt: new Date('2026-03-10T00:00:00.000Z'),
    })

    const result = await worker.run(now)

    expect(result.processedOrganizations).toBe(1)
    expect(result.archivedEvents).toBe(2)
    expect(result.deletedAudits).toBe(2)
    expect(await records.countEventRecords(org.id)).toBe(1)
    expect(await records.countArchivedEventRecords(org.id)).toBe(2)
    expect(await records.countAuditRecords(org.id)).toBe(1)
  })

  it('skips organizations that do not resolve to any retention policy', async () => {
    const org = await organizations.create('No Policy Org')

    await records.createEventRecord({
      organizationId: org.id,
      eventName: 'keep-me',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    })

    const result = await worker.run(new Date('2026-03-26T00:00:00.000Z'))

    expect(result.processedOrganizations).toBe(0)
    expect(result.skippedOrganizations).toBe(1)
    expect(await records.countEventRecords(org.id)).toBe(1)
  })
})
