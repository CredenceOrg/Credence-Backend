import type { Queryable } from './repositories/queryable.js'

const CREATE_TABLE_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT organizations_name_nonempty CHECK (length(trim(name)) > 0)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS identities (
    address TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT identities_address_nonempty CHECK (length(trim(address)) > 0)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS bonds (
    id BIGSERIAL PRIMARY KEY,
    identity_address TEXT NOT NULL REFERENCES identities(address) ON DELETE CASCADE,
    amount NUMERIC(20, 7) NOT NULL CHECK (amount >= 0),
    start_time TIMESTAMPTZ NOT NULL,
    duration_days INTEGER NOT NULL CHECK (duration_days > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'released', 'slashed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS attestations (
    id BIGSERIAL PRIMARY KEY,
    bond_id BIGINT NOT NULL REFERENCES bonds(id) ON DELETE CASCADE,
    attester_address TEXT NOT NULL REFERENCES identities(address) ON DELETE CASCADE,
    subject_address TEXT NOT NULL REFERENCES identities(address) ON DELETE CASCADE,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT attestations_unique_attester_subject_per_bond UNIQUE (bond_id, attester_address, subject_address)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS slash_events (
    id BIGSERIAL PRIMARY KEY,
    bond_id BIGINT NOT NULL REFERENCES bonds(id) ON DELETE CASCADE,
    slash_amount NUMERIC(20, 7) NOT NULL CHECK (slash_amount > 0),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT slash_events_reason_nonempty CHECK (length(trim(reason)) > 0)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS score_history (
    id BIGSERIAL PRIMARY KEY,
    identity_address TEXT NOT NULL REFERENCES identities(address) ON DELETE CASCADE,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    source TEXT NOT NULL CHECK (source IN ('bond', 'attestation', 'slash', 'manual')),
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS report_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    failure_reason TEXT,
    artifact_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS retention_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    scope_key TEXT NOT NULL,
    record_class TEXT NOT NULL CHECK (record_class IN ('event', 'audit')),
    retention_days INTEGER NOT NULL CHECK (retention_days > 0),
    disposition TEXT NOT NULL CHECK (disposition IN ('archive', 'delete')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT retention_policies_scope_key_nonempty CHECK (length(trim(scope_key)) > 0)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS retention_policy_changes (
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
  `,
  `
  CREATE TABLE IF NOT EXISTS organization_event_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_name TEXT NOT NULL,
    payload TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS organization_event_record_archives (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_name TEXT NOT NULL,
    payload TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS organization_audit_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS retention_policies_scope_key_record_class_idx ON retention_policies (scope_key, record_class)`,
  `CREATE INDEX IF NOT EXISTS bonds_identity_address_idx ON bonds (identity_address)`,
  `CREATE INDEX IF NOT EXISTS attestations_subject_address_idx ON attestations (subject_address)`,
  `CREATE INDEX IF NOT EXISTS attestations_bond_id_idx ON attestations (bond_id)`,
  `CREATE INDEX IF NOT EXISTS slash_events_bond_id_idx ON slash_events (bond_id)`,
  `CREATE INDEX IF NOT EXISTS score_history_identity_address_idx ON score_history (identity_address)`,
  `CREATE INDEX IF NOT EXISTS retention_policies_organization_id_idx ON retention_policies (organization_id)`,
  `CREATE INDEX IF NOT EXISTS retention_policy_changes_organization_id_idx ON retention_policy_changes (organization_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS organization_event_records_org_created_idx ON organization_event_records (organization_id, created_at ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS organization_audit_records_org_created_idx ON organization_audit_records (organization_id, created_at ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS organization_event_record_archives_org_created_idx ON organization_event_record_archives (organization_id, created_at ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS settlements_bond_settled_idx ON settlements (bond_id, settled_at DESC, id DESC)`,
] as const

const DROP_TABLE_STATEMENTS = [
  'DROP TABLE IF EXISTS organization_audit_records',
  'DROP TABLE IF EXISTS organization_event_record_archives',
  'DROP TABLE IF EXISTS organization_event_records',
  'DROP TABLE IF EXISTS retention_policy_changes',
  'DROP TABLE IF EXISTS retention_policies',
  'DROP TABLE IF EXISTS report_jobs',
  'DROP TABLE IF EXISTS score_history',
  'DROP TABLE IF EXISTS slash_events',
  'DROP TABLE IF EXISTS attestations',
  'DROP TABLE IF EXISTS bonds',
  'DROP TABLE IF EXISTS identities',
  'DROP TABLE IF EXISTS organizations',
] as const

export async function createSchema(db: Queryable): Promise<void> {
  for (const statement of CREATE_TABLE_STATEMENTS) {
    await db.query(statement)
  }
}

export async function resetDatabase(db: Queryable): Promise<void> {
  await db.query(
    'TRUNCATE TABLE organization_audit_records, organization_event_record_archives, organization_event_records, retention_policy_changes, retention_policies, report_jobs, score_history, slash_events, attestations, bonds, identities, organizations RESTART IDENTITY CASCADE'
  )
}

export async function dropSchema(db: Queryable): Promise<void> {
  for (const statement of DROP_TABLE_STATEMENTS) {
    await db.query(statement)
  }
}
