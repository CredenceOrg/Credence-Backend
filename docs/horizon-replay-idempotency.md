# Horizon Ingestion: Replay Safety & Idempotency

> **Issue #1261** · Backend-only · Database-boundary · Tested

Makes Horizon chain ingestion durable across retries, gaps, reorgs, and
provider faults while converging to authoritative state. Repeated, reordered,
concurrent, or timed-out deliveries of the same chain operation can never
produce a duplicate business effect.

Companion to [`docs/horizon-events-parity.md`][parity] (issue #1266), which
defines the versioned `horizon_events` ledger this design builds on.

[parity]: horizon-events-parity.md

---

## 1. Correctness invariant

> The same logical operation may be retried safely and produces a
> deterministic result **without applying the underlying business effect more
> than once**. Reusing an existing request key for a materially different
> operation is rejected deterministically. Rejected, stale, duplicate, or
> failed operations leave **no unauthorized or partially applied state**.

The invariant is enforced at the **actual business-effect boundary** — inside
the same database transaction that mutates `identities`/`bonds` — not by
suppressing duplicate HTTP responses after the effect already ran.

## 2. Durable request identity

Every chain operation is bound to a durable request key:

```
(stream_name, operation_id)
```

where `operation_id` is Horizon's globally unique operation id and
`stream_name` is the logical stream (`bond_creation`, …).

The key is committed as a row of the `horizon_events` ledger **in the same
transaction** as the business effect and the cursor checkpoint:

```
BEGIN
  claim (stream_name, operation_id)            ← durable request identity
  upsertIdentity(event.identity)
  upsertBond(event.bond)
  upsertCursorMonotonic(stream, paging_token)  ← forward-only checkpoint
COMMIT   -- or ROLLBACK on any failure
```

A ledger row therefore exists **if and only if** the operation was committed,
and it is the durable, reviewable record of that request (payload + state
hash + ordering token).

## 3. Deterministic outcomes

Processing one event in one transaction yields exactly one of:

| Outcome | Meaning | State written |
|---|---|---|
| `applied` | Operation id not committed before; effect applied | identity + bond + ledger + cursor |
| `replayed` | Operation id already committed with identical payload (verified duplicate / at-least-once redelivery) | cursor only, and only when the delivery is ahead of the checkpoint |
| `HorizonEventStaleError` | New operation id at or **behind** the stream checkpoint (reorg/gap anomaly or rolled-back cursor) | **none** — rejected before any write |
| `HorizonEventConflictError` | Same operation id replayed with a **materially different** payload (conflicting request-key reuse) | **none** — committed record and its state untouched |

## 4. How each failure mode is handled

### Retries after timeout / lost provider response

- **Committed, response lost**: the retry observes the committed ledger row,
  the payload comparison verifies it is the identical operation, and the
  outcome is `replayed`. The business effect is never applied twice, and the
  caller never needs to know which branch ran to be safe.
- **Rolled back (crash / provider fault / constraint violation before
  COMMIT)**: the ledger row and cursor move roll back with the state, so the
  retry takes the `applied` path exactly once. No partial state is observable.

### Concurrent deliveries

Two overlapping deliveries of the same operation cannot both apply: the
ledger's `UNIQUE (stream_name, event_id)` index makes the `claim()` INSERT
the single critical section, and every decision is made inside the
transaction that would carry the effect. The loser of the race observes a
committed row and returns `replayed`.

### Conflicting request-key reuse

`HorizonEventLedger.claim()`/`compareCommitted()` compare a deterministic
canonical fingerprint (`canonicalEventPayload`: keys sorted recursively) of
the incoming payload against the committed record. Identical payload →
`duplicate` (no-op). Different payload → `HorizonEventConflictError`
(`EVENT_ID_CONFLICT`): the second operation is never applied, and the state
recorded for the first is never touched. Horizon operation ids are globally
unique per chain event, so a committed key must always describe the same
logical operation.

### Stale / reordered / reorg'd events

A **new** operation id whose paging token is at or behind the stream
checkpoint is rejected with `HorizonEventStaleError` (`STALE_INGESTION_EVENT`)
before any write, so out-of-order ingestion can never regress authoritative
state. A **committed** operation re-delivered from an earlier cursor is a
verified duplicate (identical payload) or a conflict (different payload) —
never a state regression. `upsertCursorMonotonic` only ever moves the
checkpoint forward (numeric compare), so replay storms converge on the
furthest checkpoint instead of rewinding it.

### Duplicate / repeated events

Repeated delivery of a committed operation is a deterministic no-op for the
business effect. The stream cursor advances only when the redelivery is ahead
of the checkpoint, so handled events never stall the stream.

## 5. Failure behavior and compatibility

- **Public behavior**: `subscribeBondCreationEvents(dlqRouter, onEvent?, pool?)`
  keeps its existing signature. `onEvent` now fires **only for newly
  `applied` events** — a duplicate delivery can never surface a second
  business effect to subscribers. This is the one observable behavior change;
  it is strictly safer and is covered by updated listener tests.
- **New errors**: `HorizonEventConflictError` (`EVENT_ID_CONFLICT`) and
  `HorizonEventStaleError` (`STALE_INGESTION_EVENT`) are typed errors thrown
  by the ingestion boundary. They abort the transaction, so no partial state
  is possible; the listener's existing DLQ routing treats them like any
  processing error.
- **Schema**: none. Reuses the existing `horizon_events` and
  `horizon_cursors` tables (migrations `033_create_horizon_events`,
  `007_create_horizon_cursors`). No migration or rollback required.
- **Operational notes**:
  - Events quarantined to the DLQ (provider fault, conflict, stale anomaly)
    can be replayed through the existing DLQ replay flow once the condition
    is resolved; the ledger makes the replay idempotent.
  - A `STALE_INGESTION_EVENT` indicates a reorg/gap anomaly or a rolled-back
    cursor — reconcile the stream before re-ingesting rather than force-
    advancing the cursor.

## 6. Security assumptions

- Horizon operation ids are treated as globally unique chain identifiers; the
  payload fingerprint protects the ledger from conflicting reuse.
- All decisions are made inside the transaction that carries the effect, so
  no code path can apply a business effect without its durable ledger record
  (audit parity, issue #1266) or with a stale/conflicting request key.

## 7. Implementation reference

| Concern | Location |
|---|---|
| Ingestion boundary (deterministic policy, one transaction) | `src/listeners/horizonBondIngestion.ts` |
| Durable claim + conflict detection on the ledger | `src/db/repositories/horizonEventRepository.ts` (`claim`, `compareCommitted`, `canonicalEventPayload`) |
| Forward-only cursor checkpoint | `src/services/identityService.ts` (`upsertCursorMonotonic`) |
| Listener wiring | `src/listeners/horizonBondEvents.ts` |
| Boundary regression tests | `src/listeners/__tests__/horizonBondIngestion.test.ts` |
| Ledger claim/conflict tests | `src/db/repositories/horizonEventRepository.test.ts` |