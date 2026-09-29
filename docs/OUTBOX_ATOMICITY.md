# Transactional outbox contract

## Failure mode

An event-producing request has two durable effects: the business row changes
and a row in `event_outbox` becomes deliverable. If either effect uses a
different connection, a process crash can commit one without the other. A
publisher cannot repair a missing event, and a retry can repeat a business
mutation whose event was already delivered.

## Required write path

Use `AtomicOutboxCoordinator.run` (or `runOne`) for new event-producing
mutations. The mutation callback and `OutboxEventEmitter.emitBatch` receive the
same `PoolClient` from `TransactionManager`. The outbox worker does not run
until PostgreSQL commits the transaction.

```ts
const result = await atomicOutbox.runOne(
  client => accounts.updateBalance(client, input),
  account => ({
    aggregateType: 'account',
    aggregateId: account.id,
    eventType: 'account.balance_updated',
    payload: { accountId: account.id, version: account.version },
  }),
  { operation: 'account_balance_update' },
)
```

Do not call `pool.query`, publish to an external broker, or perform an HTTP
side effect from the mutation callback. Passing the transaction client is a
correctness requirement, not an optimization. Silent mutations must opt in
with `allowEmptyEvents` so missing integration records are reviewable.

## Crash-point semantics

| Point of failure | Durable result | Recovery |
| --- | --- | --- |
| before business write | neither row nor event | client retry |
| after business write, before outbox insert | rollback removes business write | client retry |
| after outbox insert, before commit | rollback removes both | client retry |
| after commit, before worker claim | both rows exist | worker claims pending row |
| after claim, before publish | state is leased | lease expiry makes it claimable |
| after publish, before acknowledgement | key identifies delivery attempt | worker skips duplicate publish |
| terminal poison failure | source row is quarantined | operator fixes and reinjects |

The coordinator cannot make a non-idempotent external provider exactly-once.
The publisher's persisted idempotency key and the provider's idempotency key
must be used together for external effects.

## Retry and poison handling

Claims are leases, not ownership forever. A worker must renew active leases;
another worker may reclaim an expired one. Transient failures use bounded
exponential backoff. Invalid JSON, invalid event schemas, oversized payloads,
and unknown event types are quarantined rather than retried forever. The
quarantine row retains the original event id, sanitized reason, retry count,
and an operator-visible reinjection path.

## Metrics and operations

Monitor pending, processing, retrying, and dead-letter gauges separately.
Alert when processing rows approach lease expiry, retry age exceeds the SLO,
or dead-letter count increases. Before rollback, stop new writers, drain
claimed rows, and verify that migration and application versions agree.

## Compatibility and rollback

The coordinator is additive and leaves existing repository SQL unchanged.
Migrate call sites incrementally, starting with mutations that already emit
webhook events. During rollback, keep the outbox worker and schema in place;
old workers understand the existing event row shape. Do not remove the
idempotency or quarantine columns until all workers have been upgraded.

## Review checklist

Before approving an event-producing mutation, verify each item below:

1. The state repository accepts the `PoolClient` supplied by the coordinator.
2. No repository silently substitutes the application-wide pool.
3. The event contains a stable aggregate and a version or idempotency value.
4. Event construction is pure and cannot perform network or filesystem I/O.
5. A failed event insert is allowed to escape and trigger rollback.
6. A failed commit is retried only when the mutation is idempotent.
7. Worker claims use `FOR UPDATE SKIP LOCKED` or the documented fallback.
8. Leases have a bounded duration and are renewed while publishing.
9. A publish crash cannot cause a second external effect without its key.
10. A malformed or unsupported event has a terminal operator-visible state.
11. Metrics expose pending, processing, retrying, and dead-letter counts.
12. Tests cover the boundary before write, after write, before commit, after
    claim, after publish, and after terminal failure.

The checklist is intentionally repetitive: most outbox incidents come from a
single new call site that bypasses an otherwise correct shared implementation.
Code review should therefore search for every direct `outboxEmitter` call and
confirm that it is already inside a `TransactionManager` callback or is moved
behind the coordinator.

## Migration sequence

For an existing write path, first identify the transaction boundary and list
all events that can be produced by the mutation. Then move each repository
call to the callback's client, construct events from the returned state, and
replace direct emission with `run` or `runOne`. Keep the worker running during
the rollout so committed rows drain continuously.

During a canary, compare business-row changes with outbox-row counts by
operation. A business write without a matching event is a release blocker.
Also inspect the inverse: an event whose aggregate version is not present in
the committed business state indicates a bypass or an incorrect retry. Stop
the canary before changing schemas if either invariant fails.

Do not use an in-memory event queue as a substitute for the database row.
Memory queues disappear on process restart and cannot participate in rollback.
Likewise, do not mark an event published before the external call has returned;
the persisted publish key exists specifically to make the crash window
recoverable.

The coordinator returns event ids to the caller for audit logging, but callers
must not use those ids to publish synchronously. The worker remains the only
publisher, which keeps external delivery out of the database transaction and
prevents a slow provider from extending row locks. If an operator needs to
replay an event, use the quarantine reinjection flow and retain the original
event id in the audit record.

Record the operation label in deployment notes for incident correlation.
