import type { Queryable } from "./repositories/queryable.js";
import { OUTBOX_TABLE_SCHEMA, OUTBOX_INDEXES } from "./outbox/schema.js";

const CREATE_TABLE_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS identities (
    address TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT identities_address_nonempty CHECK (length(trim(address)) > 0),
    CONSTRAINT identities_version_positive CHECK (version > 0)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address TEXT NOT NULL UNIQUE,
    balance NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    input_vector JSONB NOT NULL DEFAULT '{}'::jsonb,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_id TEXT NOT NULL,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
    ip_address TEXT,
    error_message TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS report_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    failure_reason TEXT,
    artifact_url TEXT,
    storage_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bond_id BIGINT NOT NULL REFERENCES bonds(id) ON DELETE CASCADE,
    amount NUMERIC(36, 18) NOT NULL CHECK (amount >= 0),
    transaction_hash VARCHAR(128) NOT NULL,
    settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT settlements_bond_tx_unique UNIQUE (bond_id, transaction_hash)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_code INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 86400,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx ON idempotency_keys (expires_at)`,
  `
  CREATE TABLE IF NOT EXISTS notification_send_attempts (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL,
    idempotency_key TEXT UNIQUE NOT NULL,
    attempt_group INTEGER NOT NULL,
    attempt_number INTEGER NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'deduped')),
    provider_response_id TEXT,
    error_message TEXT,
    attempted_at TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `CREATE INDEX IF NOT EXISTS notification_send_attempts_notification_id_idx ON notification_send_attempts (notification_id)`,
  `
  CREATE TABLE IF NOT EXISTS idempotent_job_attempts (
    id TEXT PRIMARY KEY,
    job_key TEXT NOT NULL,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    result TEXT,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (job_key, expires_at)
  )
  `,
  `CREATE INDEX IF NOT EXISTS idempotent_job_attempts_job_key_idx ON idempotent_job_attempts (job_key, expires_at)`,
  `CREATE INDEX IF NOT EXISTS bonds_identity_address_idx ON bonds (identity_address)`,
  `CREATE INDEX IF NOT EXISTS attestations_subject_address_idx ON attestations (subject_address)`,
  `CREATE INDEX IF NOT EXISTS attestations_bond_id_idx ON attestations (bond_id)`,
  `CREATE INDEX IF NOT EXISTS slash_events_bond_id_idx ON slash_events (bond_id)`,
  `CREATE INDEX IF NOT EXISTS score_history_identity_address_idx ON score_history (identity_address)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_actor_time_idx ON audit_logs (actor_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_resource_time_idx ON audit_logs (resource_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_time_idx ON audit_logs (occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS settlements_bond_id_idx ON settlements (bond_id)`,
  `CREATE INDEX IF NOT EXISTS settlements_status_idx ON settlements (status)`,
  `CREATE INDEX IF NOT EXISTS settlements_settled_at_idx ON settlements (settled_at DESC)`,
  `CREATE INDEX IF NOT EXISTS settlements_transaction_hash_idx ON settlements (transaction_hash)`,
] as const;

const DROP_TABLE_STATEMENTS = [
  "DROP TABLE IF EXISTS idempotent_job_attempts",
  "DROP TABLE IF EXISTS notification_send_attempts",
  "DROP TABLE IF EXISTS event_outbox",
  "DROP TABLE IF EXISTS settlements",
  "DROP TABLE IF EXISTS report_jobs",
  "DROP TABLE IF EXISTS score_history",
  "DROP TABLE IF EXISTS audit_logs",
  "DROP TABLE IF EXISTS slash_events",
  "DROP TABLE IF EXISTS attestations",
  "DROP TABLE IF EXISTS bonds",
  "DROP TABLE IF EXISTS idempotency_keys",
  "DROP TABLE IF EXISTS identities",
] as const;

export async function createSchema(db: Queryable): Promise<void> {
  for (const statement of CREATE_TABLE_STATEMENTS) {
    await db.query(statement);
  }
}

export async function resetDatabase(db: Queryable): Promise<void> {
  await db.query(
    "TRUNCATE TABLE settlements, report_jobs, audit_logs, score_history, slash_events, attestations, bonds, identities RESTART IDENTITY CASCADE",
  );
}

export async function dropSchema(db: Queryable): Promise<void> {
  for (const statement of DROP_TABLE_STATEMENTS) {
    await db.query(statement);
  }
  await db.query("DROP TABLE IF EXISTS idempotency_keys");
  await db.query("DROP TABLE IF EXISTS settlements");
}
