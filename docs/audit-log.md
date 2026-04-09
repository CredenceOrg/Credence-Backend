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
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  ip_address TEXT,
  error_message TEXT
);
```

### Indexes

- `(actor_id, occurred_at DESC)`
- `(resource_id, occurred_at DESC)`
- `(occurred_at DESC)`

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
- `limit`, `offset`

Examples:

```http
GET /api/admin/audit-logs?action=DISPUTE_SUBMITTED
GET /api/admin/audit-logs?actorId=admin-user-1&from=2026-01-01T00:00:00.000Z
GET /api/admin/audit-logs?resourceType=evidence&resourceId=<evidenceId>
```

## Audited Actions

- Admin: role and API key management, user listing
- Disputes: submit, mark under review, resolve, dismiss
- Governance: slash request creation and voting
- Evidence: upload and retrieval
