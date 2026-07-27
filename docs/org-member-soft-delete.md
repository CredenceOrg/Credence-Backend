# Org Member Soft-Delete and Restore

This is the operator runbook for the soft-delete + restore workflow on
the `org_members` table. It complements the API contract in
`src/services/members/service.ts` and the integration tests under
`tests/routes/members.test.ts`.

## TL;DR

| Action        | Endpoint                                                  | Status codes              |
| ------------- | --------------------------------------------------------- | ------------------------- |
| Soft-delete   | `DELETE /api/admin/orgs/:orgId/members/:memberId`         | 200 / 404 / 409           |
| Restore       | `POST   /api/admin/orgs/:orgId/members/:memberId/restore`  | 200 / 404 / 409           |
| Update role   | `PATCH  /api/admin/orgs/:orgId/members/:memberId`         | 200 / 404 / 409           |

All three endpoints require `requireUserAuth` + `requireAdminRole`.
Every mutation emits an immutable, hash-chained audit-log entry on the
`audit_logs` table.

## Schema

The `org_members` table (`src/db/schema.ts`) has:

- `deleted_at TIMESTAMPTZ NULL` — set on soft-delete, cleared on restore.
- `deleted_by UUID NULL` — admin who performed the soft-delete.
- **Partial unique index** `uq_org_members_active ON (org_id, user_id)
  WHERE deleted_at IS NULL` — guarantees that the same `(org_id,
  user_id)` pair can have at most one **active** membership, but any
  number of historical, soft-deleted rows.
- `idx_org_members_org_id ON (org_id) WHERE deleted_at IS NULL` — keeps
  the hot member-list query off the cold, deleted rows.
- An `updated_at` trigger (`trg_org_members_updated_at`) auto-bumps on
  every UPDATE.

These indexes mean the soft-delete contract is enforced **at the
database level**, not just in application code. Operator interventions
that bypass the API must still respect these constraints.

## Audit trail format

Every soft-delete, restore, and role-update emits an audit-log entry.
The entry shape is consistent with other admin actions and is
hash-chained for tamper detection.

### Soft-delete (`DELETE_MEMBER`)

```jsonc
{
  "tenantId":       "tenant-1",
  "actorId":        "admin-1",
  "actorEmail":     "admin@example.com",
  "action":         "DELETE_MEMBER",
  "resourceType":   "user",
  "resourceId":     "u1",
  "targetUserId":   "u1",
  "targetUserEmail":"alice@example.com",
  "details": {
    "memberId":   "m1",
    "orgId":      "org-1",
    "deletedAt":  "2025-…",
    "deletedBy":  "admin-1"
  },
  "status":         "success",
  "requestId":      "req-…"
}
```

A failed delete (cross-org probe, last-owner guard, already deleted)
emits the same shape with `"status": "failure"` and an `"errorMessage"`
describing the cause.

### Restore (`RESTORE_MEMBER`)

The restore event carries a **forensic snapshot** of the prior
deletion so the audit trail remains reconstructible after the row is
re-activated (the row's own `deleted_at` / `deleted_by` columns are
cleared on restore).

```jsonc
{
  "action": "RESTORE_MEMBER",
  "details": {
    "memberId":            "m1",
    "orgId":               "org-1",
    "previousDeletedBy":   "admin-1",
    "previousDeletedAt":   "2025-…",
    "deletedForSeconds":   43200
  },
  "status": "success"
}
```

`deletedForSeconds` is the wall-clock delta between the soft-delete
and the restore. This is the value to use for retention/TTL dashboards
on the `audit_logs` table for `RESTORE_MEMBER` events.

### Role update (`UPDATE_MEMBER_ROLE`)

```jsonc
{
  "action": "UPDATE_MEMBER_ROLE",
  "details": { "memberId": "m1", "oldRole": "admin", "newRole": "member", "orgId": "org-1" },
  "status": "success"
}
```

A role update that hits the last-owner guard emits a `"failure"` entry
with `"errorMessage": "Cannot demote the last active owner …"`.

## Cross-organisation authorisation

Every mutation scoped under `/api/admin/orgs/:orgId/members/…` carries
the `:orgId` URL parameter into the service request. The service then
asserts `existing.orgId === request.orgId` and refuses to mutate the
row if they differ.

Cross-org attempts:
- Surface as HTTP **`404 Not Found`** (not `403`), so probing for valid
  member IDs in neighbour organisations does not leak their existence.
- Emit a `"status": "failure"` `audit_logs` entry with
  `"requestedOrgId"` and `"rowOrgId"` in `details` so an operator can
  see the attempt in the trail.

## Last-owner guard

The service refuses to demote or soft-delete the last active `owner` of
an organisation. Without this guard, an admin could drain the role
from every owner and leave the org unmanageable.

Trigger conditions:

- Soft-delete `DELETE` where `existing.role === 'owner'` and
  `countActiveOwners(orgId) <= 1`.
- Role update `PATCH` where `existing.role === 'owner' &&
  role !== 'owner'` and `countActiveOwners(orgId) <= 1`.

Both cases:
- Return HTTP **`409 Conflict`** with the message
  `Cannot [demote|remove] the last active owner in organisation <id>`.
- Emit a `"status": "failure"` `audit_logs` entry with
  `ownerCount` and the `orgId` in `details`.

**Operator remediation:** mint a fresh owner (re-invite the user with
`role: "owner"` if no other owner exists, or promote an existing
admin) before retrying the deletion/demotion. If the org has no
remaining owners and the actors are unreachable, treat it as a support
escalation — DO NOT issue a direct SQL delete or role update from
the DB; doing so bypasses the audit trail.

### Owner self-delete

An admin can currently delete themselves if they are not the last
owner. If you want to forbid self-delete entirely, add a guard at the
service layer: `if (existing.userId === adminId) throw new Error(
'Cannot delete yourself — ask another admin to do it')`. This is a
known gap; flagged here so future maintainers can decide.

## Re-invite after soft-delete

Because the partial unique index only enforces uniqueness on
**active** rows (`deleted_at IS NULL`), an invite for the same user
after a soft-delete succeeds:

```
1. DELETE  /api/admin/orgs/org-1/members/m1          → 200 (soft-deletes)
2. POST    /api/admin/orgs/org-1/members
            { userId: "u1", email: "alice@…", role: "owner" }  → 201 (new row)
3. GET     /api/admin/orgs/org-1/members?includeDeleted=true
            → returns both the soft-deleted (deleted_at set) and
              the new active row (deleted_at null)
```

This is intentional — it preserves the historical membership record
while letting the org reactivate the relationship.

## Retention

`org_members` rows are **NOT** subject to retention. Soft-deleted rows
remain forever so the audit trail stays consistent with the table
state.

`audit_logs` rows have a 90-day TTL applied by
`src/jobs/dataRetentionJob.ts`. Long-term forensic queries that
require deletion history older than 90 days should pull from
`audit_logs` archive (not yet implemented) or a snapshot export.

## Investigating stuck soft-deletes

If a soft-delete appears "stuck" (the row is not visibly marked):

```
SELECT id, org_id, user_id, role, deleted_at, deleted_by, updated_at
  FROM org_members
 WHERE deleted_at IS NULL
   AND updated_at < NOW() - INTERVAL '10 minutes';
```

This returns rows that were touched recently but never got
`deleted_at` set. In practice the soft-delete should be near-instant;
anything older than 10 minutes indicates a stuck client connection or
a long-running transaction holding the row. Page on-call if the count
is non-zero.

## On-call playbook

| Symptom                                          | First action                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `Cannot demote the last active owner`            | Mint another owner via `POST /members { role: "owner" }` for a different admin user.           |
| `Member not found in organisation <id>: <uuid>`  | Confirm the URL `:orgId` is correct. This is the cross-org guard at work.                       |
| `Cannot restore: an active membership already exists` | The user was re-invited before the restore. Update the new active row's role instead of restoring the deleted row. |
| Restore audit detail missing `previousDeletedBy` | Schema-level backfill needed — older events may not carry the snapshot. Replay from source.    |
