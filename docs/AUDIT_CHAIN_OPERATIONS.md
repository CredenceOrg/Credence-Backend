# Audit-chain integrity operations

The audit log is evidence, not an ordinary application cache. Each entry binds
its canonical content to the previous entry hash. Verification must identify
the first untrusted sequence and must fail closed for compliance-sensitive
consumers when the repository cannot provide a complete chain.

## Canonical entry content

The row hash is SHA-256 over the pipe-delimited fields:

```text
previousHash|id|occurredAt|actorId|action|resourceType|resourceId|
detailsJson|status|tenantId|requestId
```

The genesis value is the literal `GENESIS`. `detailsJson` is generated from the
stored structured details. Producers must keep key ordering deterministic before
append; consumers must not reconstruct hashes from display-formatted JSON.

The signed fields include actor, action, resource, status, tenant, request ID,
timestamp, details, and the link to the previous hash. A change to any one of
these fields produces a different row hash and invalidates the chain from the
first modified entry onward.

## Verification result

`AuditLogService.verifyChain()` loads entries, orders them by sequence, and
returns a structured `ChainVerificationResult`:

- `valid` is true only when every row and link verifies;
- `rowsChecked` records the number examined;
- `lastCheckedSeq` records the highest sequence considered;
- `firstViolationSeq` and `firstViolationId` identify the earliest break;
- `violationCount` gives the total number of detected violations; and
- `violations` provides expected and actual hash evidence.

The verifier reports the first broken sequence rather than only a boolean. This
lets operations stop compliance exports at a trustworthy boundary and prioritize
the earliest evidence. Later violations are still returned for investigation.

## Violation types

| Type | Meaning | Response |
| --- | --- | --- |
| `prev_hash_mismatch` | A row does not link to the prior verified row. | Quarantine the row and investigate ordering or deletion. |
| `row_hash_mismatch` | Canonical content differs from the stored row hash. | Treat the row as tampered until independently restored. |
| `missing_row` | Sequence is absent or cannot be read. | Fail closed; do not infer or synthesize evidence. |
| `deleted_row` | Reserved evidence classification for repository adapters. | Preserve the gap and escalate for forensic review. |

An unreadable repository result is also invalid. A database timeout or malformed
adapter response must not be presented as a healthy empty chain.

## Fail-closed consumers

Compliance exports, incident reports, and administrative health checks should
inspect the latest verification status before treating the audit history as
complete. If `status` is `break_detected`, consumers should:

1. stop exporting rows after the first break;
2. retain the verification result and checked-at timestamp;
3. notify the security or compliance owner;
4. preserve the original database or object-store snapshot; and
5. require an explicit decision before any repair marker is appended.

`never_run` is not equivalent to `valid`. A deployment should run verification
before advertising audit readiness and should monitor the persisted status for
staleness.

## Repair is append-only

The service does not expose a method that overwrites, deletes, or re-hashes an
existing evidence row. `requestChainRepair` requires an operator ID, independent
approval, authorization reference, and reason. It appends a
`CHAIN_REPAIR_REQUESTED` marker carrying the authorization context. That marker
is itself part of the chain and does not make the earlier break disappear.

Repair work happens in an external, controlled process. It may create a new
verified export, attach an independent evidence object, or migrate data into a
new chain, but it must retain the original broken chain unchanged. A repair
ticket must link the original verification result, snapshots, operator approval,
and resulting export.

The following actions are prohibited as “repair” shortcuts:

- updating `prev_hash` in place;
- replacing `row_hash` without a new evidence chain;
- deleting the first broken row;
- inserting a fabricated row to close a sequence gap; or
- marking a failed verification as valid without a new verification run.

## Startup and monitoring

At startup, the configured audit backend should be reachable before the service
reports audit readiness. A scheduled verifier should call `verifyChain`, persist
the result, and expose the status through the existing chain-status endpoint.
Monitoring should alert on:

- `break_detected` status;
- `never_run` after the startup grace period;
- a verification timestamp older than the operational interval;
- a nonzero violation count;
- an unexpected first-break sequence; and
- repeated repair requests for the same chain.

The health signal should distinguish “backend unavailable” from “backend
available but chain invalid.” Both are unsafe for compliance exports, but the
remediation paths differ.

## Concurrency and ordering

Postgres append uses the database sequence and transaction to select the current
tail and compute the next link. The in-memory repository uses a monotonic counter
for deterministic tests. Verification always sorts by `seq`, not by display
timestamp, because two concurrent requests can have close or reordered clocks.

If a repository adapter cannot provide sequence, previous hash, row hash, and
canonical fields together, it must return an error and the verifier must fail
closed. An adapter must not silently substitute a timestamp order or omit a
missing hash.

## Tenant isolation

The chain is currently verified over the repository's configured audit scope.
Cross-tenant administrative operations must use an explicit super-scope and must
record that decision. A tenant-scoped export must not combine rows from unrelated
chains without a documented chain identity and independent verification.

When a shared global sequence is used, a tenant filter can begin in the middle
of the global chain and should not be described as a tenant-genesis chain. When
separate tenant chains are introduced, each needs an explicit genesis anchor.

## Evidence handling

Store verification results with:

- the verifier version;
- repository/backend identity;
- checked-at timestamp;
- first break sequence and ID;
- violation count;
- snapshot or export reference; and
- operator or scheduler identity.

Do not put private keys, database credentials, or raw authorization tokens into
details. Authorization references should point to a controlled ticket system.
Exports must preserve row IDs, sequence numbers, hashes, and original timestamps
without normalizing away null or malformed values.

## Compatibility and rollout

The hash fields and existing append/query APIs remain compatible. Verification is
additive and can be enabled before compliance consumers enforce the status. A
rollout should proceed in stages:

1. deploy the verifier and tests;
2. run it in observation mode and collect baseline results;
3. verify empty and healthy chains;
4. inject controlled tamper fixtures in a non-production environment;
5. enable fail-closed exports;
6. enable alerts and on-call ownership; and
7. document the repair and evidence workflow.

Rollback must not remove hash columns, status records, or verification evidence.
If the verifier is rolled back, the last known status remains an operational
fact and should not be reset to `never_run` without an explicit migration.

## Test matrix

The integrity suite covers:

- a healthy canonical chain;
- tampering with every signed field;
- deletion and insertion sequence gaps;
- missing row hashes and malformed details;
- deterministic sequence ordering independent of timestamps;
- concurrent append behavior;
- persisted healthy status;
- explicit authorization for repair requests; and
- append-only repair markers that preserve historical IDs.

The test suite intentionally checks both the boolean result and the forensic
coordinates of the first break. A green test must demonstrate that the system
can explain why it rejected a chain, not merely that it rejected it.

## Review checklist

- [ ] Canonical content includes every signed field.
- [ ] Genesis and previous-hash behavior are documented.
- [ ] First broken sequence is reported.
- [ ] Missing or unreadable rows fail closed.
- [ ] Verification status is persisted and monitored.
- [ ] Repair requires explicit operator authorization.
- [ ] Repair never overwrites historical evidence.
- [ ] Concurrent appends retain deterministic sequence links.
- [ ] Tenant and super-scope behavior is explicit.
- [ ] Full CI runs without disabled or deleted checks.
