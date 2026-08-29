# Horizon Ingestion: Events and Audit Parity

Issue: [#1266][i1266] — make chain ingestion durable across retries, gaps,
reorgs, and provider faults while converging to authoritative state.

[i1266]: https://github.com/CredenceOrg/Credence-Backend/issues/1266

## Objective

Every Horizon transition that the repository commits (bond creation, and later
withdrawal / attestation streams) must produce a **versioned, complete,
correlation-identified record**, written in the same database transaction as
the state mutation. Reconciliation then proves, deterministically and
reviewably, that the committed records and the final state agree — so balances,
bonds, and trust scores can never silently diverge from the ledger.

## Design

### 1. The event ledger (`horizon_events` table)

Migration `033_create_horizon_events` adds an append-only ledger. One row per
committed chain event:

| Column          | Meaning |
|-----------------|---------|
| `stream_name`   | Logical stream (`bond_creation`, …) |
| `event_id`      | Horizon operation id — **correlation identifier** between chain and DB |
| `paging_token`  | Horizon paging token — **ordering key** (monotonic per stream) |
| `ledger_seq`    | Ledger sequence parsed from the paging token, when available |
| `event_type`    | Event discriminator (`create_bond`, …) |
| `payload`       | **Complete** validated event payload (JSONB) — reviewable without re-querying Horizon |
| `state_hash`    | Deterministic SHA-256 of the identity state the event produced |
| `created_at`    | Commit time |

The `UNIQUE (stream_name, event_id)` index makes at-least-once replay
idempotent: re-delivering the same operation is an `ON CONFLICT DO NOTHING`
no-op and can never duplicate a record or re-run side effects.

### 2. Commit-time invariant (no partial state)

`subscribeBondCreationEvents` now performs the state mutation, the ledger
record, and the cursor checkpoint inside **one transaction**:

```
BEGIN
  upsertIdentity(event.identity)
  upsertBond(event.bond)
  INSERT INTO horizon_events (...)          ← ledger record (idempotent)
  upsertCursor(stream, paging_token)
COMMIT   -- or ROLLBACK on any failure
```

Consequences:

- A ledger record **only ever exists for a committed transition**. If the
  process crashes before `COMMIT`, or any statement fails (constraint,
  provider fault), everything rolls back: no "event without state" and no
  "state without event" window is observable.
- If the ledger write itself fails, the state write is rolled back too —
  a state change without a reviewable record is exactly the parity violation
  this issue prevents. The failed event is routed to the DLQ
  (`failed_inbound_events`) with `PROCESSING_ERROR` and the cursor does not
  advance, so it is retried by the next owner.
- Rejected payloads (schema validation failure) are quarantined to the DLQ
  with `SCHEMA_VALIDATION_FAILED` **before** any transaction opens; they never
  touch state or the ledger.

### 3. Reconciliation (`src/services/horizonParity.ts`)

`verifyHorizonParity` is a pure, deterministic function over the ledger
records and the current `identities` state. It performs two independent
checks:

1. **Record integrity** — recompute `state_hash` from the recorded payload
   and compare to the stored value. A mismatch means the record was tampered
   with or the payload mutated after commit.
2. **State convergence** — fold all committed `create_bond` events for an
   address in `paging_token` order (mirroring the listener's upsert
   semantics: last event wins for amount/duration, first event sets
   `bond_start`, `active = true`) and compare with the address's current
   committed state.

Findings are typed and reviewable:

| Kind | Meaning |
|------|---------|
| `record_hash_mismatch` | Stored `state_hash` does not match the payload (tampering). |
| `state_mismatch` | Committed state diverges from the folded event ledger (drift). |
| `event_without_state` | A committed event exists but no identity state was written (partial write). |
| `state_without_event` | Identity state exists with no accounting event (silent gap — e.g. state written out-of-band). |

`HorizonParityService.verify(streamName)` binds the verifier to the
`horizon_events` ledger and the `identities` table for scheduled runs.

### 4. Documented ordering

Within a stream, records are ordered by `paging_token` ascending (then
insertion id). `HorizonEventLedger.list()` returns records in this order and
supports `afterPagingToken` for ordered resume. `EVENT_ORDERING.md` documents
the Ledger/Horizon ingestion guarantee as *monotonically increasing by ledger
sequence, at-least-once*; the ledger's `paging_token`/`ledger_seq` columns are
the machine-readable form of that ordering.

## Failure behavior and compatibility

- **Public behavior**: `subscribeBondCreationEvents(dlqRouter, onEvent?, pool?)`
  keeps its existing signature. The ledger is a new optional 4th parameter
  (`eventLedger`) that defaults to a real `HorizonEventLedger` on the passed
  pool, so existing callers opt in automatically on deploy; tests may inject
  a double. No response shapes or error codes change.
- **Migration**: additive; `033_create_horizon_events` creates one table and
  two indexes. Rollback is `pgm.dropTable('horizon_events')`.
- **Deployment order**: run the migration **before** deploying the listener
  code. If the listener runs against a database without `horizon_events`, the
  ledger write fails and the event is rolled back and routed to the DLQ
  (fail-closed), which is the correct safety posture — state never changes
  without a reviewable record. The DLQ keeps the event for replay once the
  migration is applied.
- **Operational note**: events quarantined because the ledger was unavailable
  (`PROCESSING_ERROR`) can be replayed through the existing DLQ replay flow
  once the table exists.

## Security assumptions

- The ledger is written with the same application role that mutates
  identity/bond state; no new credentials or grants are introduced.
- `state_hash` uses SHA-256 over canonical JSON with sorted keys; it is a
  tamper-evidence hash for parity checking, not a replacement for the
  hash-chained `audit_logs` (which remains the integrity trail for admin
  actions).
- Paging tokens are validated (`/^\d+$/` or `'now'`) before persistence,
  matching `CursorRepository`/`upsertCursor`; all SQL is parameterized.

## Out of scope / follow-ups

- `horizonWithdrawalEvents.ts` still contains mock persistence; wiring the
  withdrawal stream through the ledger is a natural follow-up.
- Scheduling `HorizonParityService.verify` on an interval and alerting on
  `valid === false` (like `settlementReconciler`) is a follow-up.
