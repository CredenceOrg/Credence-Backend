import { describe, it, expect, beforeEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { OrganizationRepository } from './organizationRepository.js'
import { RetentionPolicyRepository } from './retentionPolicyRepository.js'

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

  return pool
}

describe('RetentionPolicyRepository', () => {
  let pool: Pool
  let organizations: OrganizationRepository
  let repository: RetentionPolicyRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    organizations = new OrganizationRepository(pool)
    repository = new RetentionPolicyRepository(pool)
  })

  it('prefers organization override over the global default', async () => {
    const org = await organizations.create('Acme Health')

    await repository.upsertPolicy({
      recordClass: 'event',
      retentionDays: 90,
      disposition: 'archive',
      changedBy: 'system',
    })
    await repository.upsertPolicy({
      organizationId: org.id,
      recordClass: 'event',
      retentionDays: 30,
      disposition: 'archive',
      changedBy: 'admin-1',
      reason: 'Lower event retention for premium tenant',
    })

    const resolved = await repository.resolvePolicy(org.id, 'event')

    expect(resolved).not.toBeNull()
    expect(resolved!.organizationId).toBe(org.id)
    expect(resolved!.retentionDays).toBe(30)
  })

  it('falls back to the global policy when no organization override exists', async () => {
    const org = await organizations.create('Fallback Org')

    await repository.upsertPolicy({
      recordClass: 'audit',
      retentionDays: 180,
      disposition: 'delete',
      changedBy: 'system',
    })

    const resolved = await repository.resolvePolicy(org.id, 'audit')

    expect(resolved).not.toBeNull()
    expect(resolved!.organizationId).toBeNull()
    expect(resolved!.retentionDays).toBe(180)
    expect(resolved!.disposition).toBe('delete')
  })

  it('records auditable policy change history', async () => {
    const org = await organizations.create('Audited Org')

    await repository.upsertPolicy({
      organizationId: org.id,
      recordClass: 'audit',
      retentionDays: 365,
      disposition: 'delete',
      changedBy: 'admin-1',
      reason: 'Initial policy',
    })
    await repository.upsertPolicy({
      organizationId: org.id,
      recordClass: 'audit',
      retentionDays: 120,
      disposition: 'delete',
      changedBy: 'admin-2',
      reason: 'Compliance update',
    })

    const changes = await repository.listPolicyChanges(org.id)

    expect(changes).toHaveLength(2)
    expect(changes[0].changedBy).toBe('admin-2')
    expect(changes[0].previousRetentionDays).toBe(365)
    expect(changes[0].newRetentionDays).toBe(120)
  })
})
