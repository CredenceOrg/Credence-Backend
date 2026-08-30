# Import validation, row outcomes, and safe resume

The import commit endpoint performs a complete validation pass before it calls
the persistence adapter. It then commits valid rows as independent units and
records a stable outcome for each row. This makes a large import observable
and resumable without pretending that a set of independent database upserts is
one transaction.

## Commit contract

| Concern | Contract |
| --- | --- |
| Validation | Encoding, CSV shape, headers, mapping, addresses, email values, and duplicate addresses are checked before writes. |
| Atomicity | The validation phase is atomic: an invalid file causes zero writes. The persistence phase is partial per row. |
| Ordering | Validated rows are committed in source order. |
| Row identity | SHA-256 row keys include the import fingerprint, source row number, and mapped fields. |
| Operation identity | `operationId` is stable for one tenant-scoped idempotency key. |
| Resume | A retry skips accepted rows and attempts only rows recorded as retryable. |
| Failure response | Partial persistence returns `207` with `committed: false` and row outcomes. |
| Validation response | Invalid input returns `422` with rejected-row reasons and zero writes. |
| Sensitive data | Row outcomes contain row number, key, code, and safe message; they do not echo row values. |

## Two-phase behavior

The endpoint has two deliberate phases.

### Phase one: validation

`dryRunImportFile` reads the complete uploaded buffer through the existing
streaming parser. It validates UTF-8, file size, CSV structure, header mapping,
cell limits, required address format, optional email format, and duplicate
addresses. The same pass produces bounded row-level error objects.

If any validation error exists, `commitImportFile` returns before creating a
checkpoint or calling `upsertRow`. This is the transactional boundary for bad
input: malformed, unauthorized-by-route, or duplicate data cannot partially
write merely because an earlier row happened to be valid.

### Phase two: persistence

After a successful dry run, the service parses the same validated input into
write-ready rows. It calls the committer one row at a time. A success is saved
as `accepted`; an adapter exception is saved as `retryable` with a generic
message. The next row still runs after an individual failure.

This partial policy is necessary because the current committer represents
independent database upserts and may be replaced by an external adapter. A
later row cannot safely undo an earlier database or ledger commit. Callers
should reconcile the returned `rowOutcomes` rather than infer all-or-nothing
behavior from the HTTP status.

## Idempotency and checkpoints

Clients should send the same `Idempotency-Key` for every retry of one logical
file. The route combines that key with the trusted tenant context before it
looks up the checkpoint. Identical keys from different tenants therefore cannot
reuse one another's operation record.

The checkpoint stores:

- a stable operation ID;
- an import fingerprint covering the complete file and column mapping;
- accepted and retryable row outcomes; and
- whether every row is currently accepted.

Reusing a key with a different file or mapping returns `409
IdempotencyConflict` before the second file can write. Changing row order also
changes the file fingerprint and is treated as a new request shape, preventing
an operator from silently attaching a reordered file to an old checkpoint.

Successful row outcomes are immutable for the lifetime of the checkpoint. A
retry returns them and does not call the committer again. Retryable rows are
attempted again in source order. When they succeed, their same row keys move to
`accepted`. This is the important distinction between safe resume and blindly
replaying the complete file.

Concurrent requests with the same tenant-scoped key use the checkpoint store's
per-key lock. The second request waits while the first request is writing its
outcomes, then observes the accepted rows and skips them. A production shared
checkpoint adapter must implement the same lock/claim behavior atomically in
the database or coordination service; an in-memory lock is process-local.

## Row keys and information exposure

The row key is a digest of the import fingerprint, source row number, and
mapped fields. It is stable across retries of the identical file, but it is not
an address lookup key and is not returned with the raw data. Row numbers remain
available to operators for locating a source line in the file they already
control.

Rejected and retryable outcomes intentionally use generic messages. They expose
the machine-readable reason (`INVALID_ADDRESS`, `DUPLICATE_KEY`, or
`CommitFailed`) and the source row, but never include email, name, wallet
address, API key, or adapter exception text. This keeps import diagnostics
useful without turning an error endpoint into a data-exfiltration surface.

Validation errors retain the established dry-run error schema so callers can
show actionable column-specific feedback. A new `rowOutcomes` projection adds
stable status and key fields without replacing the existing error list.

## Metrics and audit trail

`import_rows_total{status=...}` records accepted, rejected, and retried row
events. It contains only the status label and count; payload fields are never
used as metric labels. Accepted is incremented when a row is newly persisted,
rejected is incremented for validation or persistence rejection, and retried is
incremented when a previously retryable row is attempted again.

The response's `operationId` and `rowOutcomes` provide the request-level audit
trail for the current API surface. A production adapter should persist the
same operation and row records alongside its import audit event, including the
tenant, actor, key fingerprint, timestamps, and outcome transitions. It should
not persist raw credentials in those audit labels.

## Authorization and tenant safety

The commit routes continue to require `ADMIN_WRITE` before reading or writing
the uploaded file. The idempotency scope uses `getTenantId()` from the trusted
tenant context established by authentication. A client-supplied tenant field
is not accepted as an override.

Mapping presets are loaded through the existing repository and remain subject
to the same route authorization and tenant checks. The preset mapping is part
of the fingerprint, so a retry after a preset version or mapping change cannot
reuse a stale operation record.

## Failure and rollback boundary

If validation fails, rollback is automatic because no committer call has been
made. If row three fails after rows one and two succeed, rows one and two stay
committed and row three is retryable. The endpoint returns `207` so clients
cannot mistake a partial operation for a fully committed import.

If the process crashes after an adapter commits but before the checkpoint is
updated, a process-local store cannot prove whether the external write landed.
The production adapter must use a database transaction, adapter-level
idempotency, or reconciliation by a provider operation ID. The current
`PoolImportCommitter` uses an address upsert, which makes the database write
itself repeat-safe, but the coordination record still needs shared persistence
for multi-worker crash recovery.

Rollback of this release is schema-safe because no migration is required for
the in-memory store. A deployment that adopts a persistent checkpoint table
should keep the table additive, deploy readers before writers, and retain old
commit responses until clients have migrated to operation-aware handling.

## Client recovery algorithm

1. Upload the file with a new idempotency key for a new logical import.
2. If validation returns `422`, correct the reported rows and use a new key for
   the corrected file.
3. If persistence returns `207`, save `operationId` and all row outcomes.
4. Retry the identical file and key after a retryable adapter failure.
5. Treat accepted rows as complete even when they are returned from a replay.
6. Stop and investigate a `409 IdempotencyConflict`; do not change the file
   under the old key.
7. Use `rowKey`, row number, and error code to reconcile the final result.

Do not generate a new key after a network timeout unless the operator has
verified that the original operation did not run. A new key intentionally
creates a new operation and may repeat external work.

## Test matrix

The resumable commit tests cover:

- malformed and mixed-validity files with zero writes;
- stable row keys and operation IDs;
- a successful row followed by a retryable failure;
- resuming only the failed row;
- idempotency fingerprint conflicts;
- tenant-scoped keys;
- concurrent same-key calls;
- partial-commit behavior without cross-row rollback; and
- rejection messages that do not expose source values.

Existing import preview, mapping, route, and commit tests remain unchanged
and continue to verify file-size, encoding, CSV, formula-injection, preset,
authorization, and dry-run behavior.
