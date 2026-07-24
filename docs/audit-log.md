# Audit Log for Sensitive Actions

## Overview

The backend records immutable audit entries for sensitive actions across admin, governance, dispute, and evidence flows.

Each audit entry captures:

- `who`: `actorId`, `actorEmail`
- `what`: `action`
- `when`: `timestamp`
- `resource`: `resourceType`, `resourceId`

## Storage

Audit records are stored in `audit_logs` with append-only semantics in application code:

- Writes use repository `append(...)`
- Queries use repository `query(...)`
- No update or delete API is exposed for runtime feature code

### Table

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seq BIGINT NOT NULL DEFAULT nextval('audit_logs_seq'),
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  ip_address TEXT,
  error_message TEXT,
  tenant_id TEXT NOT NULL,
  prev_hash TEXT,
  row_hash TEXT
);
```

### Indexes

- `(actor_id, occurred_at DESC)`
- `(resource_id, occurred_at DESC)`
- `(occurred_at DESC)`
- `(seq ASC)` — used by the chain verifier

## Hash Chain (Tamper Detection)

### How It Works

Every audit log row is part of a **SHA-256 hash chain** that makes any tampering (mutation, deletion, re-ordering) detectable:

1. **`prev_hash`** — The `row_hash` of the immediately preceding row (by `seq` order). `NULL` for the genesis (first) row.
2. **`row_hash`** — `SHA-256( prev_hash | id | occurred_at | actor_id | action | resource_type | resource_id | details_json | status | tenant_id )`.
3. **`seq`** — A monotonically increasing sequence number from `audit_logs_seq` that provides a deterministic total order, even when multiple rows share the same `occurred_at` timestamp.

### Hash Computation

The hash input is a pipe-delimited concatenation of all significant fields:

```
SHA-256( COALESCE(prev_hash, 'GENESIS') | id | occurred_at | actor_id | action | resource_type | resource_id | details_json | status | tenant_id )
```

For the genesis row, the string `"GENESIS"` is used in place of `prev_hash`.

### Insert Flow

1. The `PostgresAuditLogsRepository.append()` method uses a single SQL statement with CTEs to atomically:
   - Fetch the `row_hash` of the latest row (by seq)
   - Allocate the next sequence value
   - Compute the new `row_hash` using PostgreSQL's `sha256()` function
   - Insert the row with `prev_hash` and `row_hash`
2. For the `InMemoryAuditLogsRepository`, the hash is computed in Node.js using `crypto.createHash('sha256')`.

### Concurrency

Concurrent writers are serialized by the `seq` sequence. The CTE-based insert atomically reads the previous hash and inserts the new row, ensuring the chain is always consistent. The `audit_logs_seq_unique` constraint prevents duplicate sequence values.

## Chain Verification

### Verifier Job

The `AuditChainVerifier` (`src/jobs/auditChainVerifier.ts`) runs every **15 minutes** and walks the entire chain to detect:

| Violation Type | Description |
|---|---|
| `prev_hash_mismatch` | A row's `prev_hash` does not match the `row_hash` of the previous row |
| `row_hash_mismatch` | A row's stored `row_hash` does not match the recomputed hash (row was mutated) |
| `deleted_row` | A gap in the `seq` sequence (row was deleted from the table) |

### Evidence Erasure Proofs

When evidence is crypto-shredded at end-of-retention, an `EVIDENCE_SHREDDED` audit entry is created containing:

| Field | Description |
|-------|-------------|
| `details.proofJwt` | JWT signed by keyManager with payload `{ evidence_id, erased_at, nonce, tenant_id, actor_id }` |
| `details.shreddedAt` | ISO timestamp of the shred operation |
| `resourceId` | The `evidence_id` of the shredded record |

Retrieve proofs via:

```http
GET /v1/admin/erasure-proof/<evidence_id>
```

The proof JWT is signed with PS256 and includes a random UUID nonce for replay protection. The signature can be independently verified against the platform's JWKS endpoint (`/.well-known/jwks.json`).

### Security: Read-Only Role

**The verifier MUST run with a read-only database role** to limit blast radius. If an attacker compromises the verifier's credentials, they cannot modify the audit log.

```sql
-- Example: create a read-only role for the verifier
CREATE ROLE audit_verifier_ro WITH LOGIN PASSWORD '...';
GRANT SELECT ON audit_logs TO audit_verifier_ro;
```

### Prometheus Metrics

| Metric | Type | Description |
|---|---|---|
| `audit_chain_integrity_violation_total` | Counter | Total number of chain violations detected |
| `audit_chain_verifier_rows_checked` | Gauge | Number of rows checked in the last run |
| `audit_chain_verifier_last_run_timestamp` | Gauge | Unix timestamp of the last verification run |
| `audit_chain_verifier_last_run_valid` | Gauge | 1 if last run found no violations, 0 otherwise |

### Alerting

A **critical** Prometheus alert fires immediately (no `for` duration) when `audit_chain_integrity_violation_total > 0`:

```yaml
- alert: AuditChainIntegrityViolation
  expr: audit_chain_integrity_violation_total{job="credence-backend"} > 0
  for: 0m
  labels:
    severity: critical
  annotations:
    summary: "Audit log chain integrity violation detected"
```

A **warning** alert fires if the verifier hasn't run in 30 minutes:

```yaml
- alert: AuditChainVerifierStale
  expr: (time() - audit_chain_verifier_last_run_timestamp{job="credence-backend"}) > 1800
  for: 5m
  labels:
    severity: warning
```

## Querying

Admin endpoint:

```http
GET /api/admin/audit-logs
```

Supported filters:

- `action`
- `actorId` (alias: `adminId`)
- `resourceId` (alias: `targetUserId`)
- `resourceType`
- `status`
- `from` (ISO timestamp)
- `to` (ISO timestamp)
- `limit` (max 100)
- `cursor` (opaque keyset cursor for pagination)

Examples:

```http
GET /api/admin/audit-logs?action=DISPUTE_SUBMITTED
GET /api/admin/audit-logs?actorId=admin-user-1&from=2026-01-01T00:00:00.000Z
GET /api/admin/audit-logs?resourceType=evidence&resourceId=<evidenceId>
```

## Export

```http
GET /api/audit/export?from=2026-01-01&to=2026-06-01
```

Streams audit logs as NDJSON with PII redaction applied. Rate-limited to 10 requests per minute.

## Audited Actions

- Admin: role and API key management, user listing
- Disputes: submit, mark under review, resolve, dismiss
- Governance: slash request creation and voting
- Evidence: upload, retrieval, and crypto-shred (EVIDENCE_SHREDDED)

## Migration

The hash chain was added in migration `010_add_audit_hash_chain.ts`:

1. Adds `seq`, `prev_hash`, and `row_hash` columns
2. Creates `audit_logs_seq` sequence for deterministic ordering
3. Backfills existing rows with computed hashes

### Running the migration

```bash
npm run migrate:dev
```

### Rolling back

```bash
npm run migrate:down
```

This removes the `seq`, `prev_hash`, and `row_hash` columns and drops the sequence.

## Incident Response

### When AuditChainIntegrityViolation fires

1. **Do NOT modify the audit_logs table** — preserve evidence.
2. Check the verifier logs for violation details (seq, id, type).
3. Compare the affected rows against application logs and backup snapshots.
4. Determine whether the tampering was accidental (e.g., a migration bug) or malicious.
5. If malicious, escalate to security team and initiate forensic analysis.
6. Restore from the last known-good backup if necessary.
