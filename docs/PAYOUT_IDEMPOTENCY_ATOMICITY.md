# Payout idempotency and concurrent retries

Payout creation is a side-effecting operation. A client can lose the HTTP
response after the provider or settlement database has accepted the request and
then retry. The retry path must converge on the existing result instead of
executing a second payout instruction.

## Failure mode

The unsafe sequence is:

1. request A checks for an idempotency key;
2. request B checks the same key before A saves its response;
3. both requests find no row;
4. both execute the payout operation; and
5. both save a response.

The final idempotency row does not repair the duplicate external side effect.
The protection must cover the interval from the first lookup through durable
response persistence.

## Process-local in-flight barrier

The middleware now keeps a keyed in-flight promise while a request with an
idempotency key is being handled. A second request for the same key waits for
the first request's response persistence before looking up the key again. It
then replays the stored response or applies the existing actor/payload mismatch
rule.

The lock is released in all terminal paths:

- an existing compatible row is replayed;
- an actor or payload mismatch is rejected;
- a successful or client-error response is saved;
- a transient server response is not cached; or
- the request/response closes unexpectedly.

Release is idempotent, so both `close` and the save completion callback can run
without corrupting the lock map. A failed save is logged and releases the lock;
the next retry can then observe the durable absence and attempt recovery.

## Durable source of truth

The process-local barrier is a latency and concurrency guard, not a replacement
for durable storage. The idempotency repository remains authoritative across
workers, restarts, and deployment rollouts. Database deployments must retain a
unique constraint on the key and should use an atomic insert/reservation pattern
when a multi-process payout executor is enabled.

The implementation deliberately does not store an in-memory success result as
the only response. A process crash after provider submission but before the
database save remains an ambiguous operation and must be reconciled through the
provider reference or settlement record before a new instruction is sent.

## Identity binding

The key is bound to the authenticated actor and canonical request payload. A
compatible replay requires both bindings to match. A stolen key cannot be used
by another actor, and the same actor cannot silently change amount, recipient,
currency, transaction reference, or status under an existing key.

The comparison uses the bound hash and constant-time equality. The stored
response is returned only after the binding check. Duplicate detection therefore
does not weaken tenant isolation or disclose another actor's payout result.

## State model

The request lifecycle is:

```text
absent -> executing -> response persisted -> replayable
             |                  |
             +---- 5xx ----------+ (not cached; reconcile before retry)
             +---- 4xx ----------+ (validation/error policy applies)
```

The current response-cache schema stores completed responses. A production
multi-worker reservation can represent `executing` explicitly with an owner,
lease, provider reference, and recovery deadline. Until that migration is
enabled, the process barrier covers concurrent requests in one worker and the
database uniqueness/settlement constraints remain the cross-worker backstop.

## Provider ambiguity

Timeouts and provider 5xx responses do not prove that no payout occurred. The
caller must not blindly retry with a new key. Recovery should:

1. locate the durable payout or settlement row;
2. query the provider using its request/reference identity;
3. compare amount, recipient, currency, and actor context;
4. mark the local state as sent, completed, or permanently failed; and
5. emit or retain the same audit correlation context.

If the provider cannot reconcile the request, quarantine it for operator review.
Do not turn an ambiguous timeout into a fresh payout instruction merely because
the idempotency response was not persisted.

## Response persistence

The response is serialized and saved before the in-flight lock is released for
successful and client-side outcomes. The HTTP response is still sent through
Express immediately; the lock completion is tied to the repository save promise.
This prevents the second same-key request from racing ahead of the save while
preserving normal response latency characteristics.

Transient 5xx responses are not cached. A retry after a 5xx must pass through
the payout recovery policy and must not receive a stale failure as if the
operation were completed. A validation 4xx is governed by the existing policy;
the request is not allowed to become a successful replay record.

## Recovery and audit context

Every payout request should carry a request ID through the route, settlement
service, provider adapter, database/outbox record, and audit event. A duplicate
replay returns the original response and should preserve the original request
correlation in the response body or headers where the API contract allows.

A recovery action must identify the original idempotency key, actor, payload
hash, provider reference, local payout ID, and operator reason. The recovery
record should distinguish “already sent,” “provider failed,” “permanently
failed,” and “requires manual reconciliation.”

## Concurrent request matrix

| Request A | Request B | Required result |
| --- | --- | --- |
| same actor/key/payload | same actor/key/payload | one execution; B replays A |
| same actor/key/payload | same actor/key/different payload | B gets mismatch |
| actor A/key/payload | actor B/same key | B gets mismatch |
| success | retry after save | replay original status/body |
| timeout before save | retry same key | reconcile durable/provider state |
| 5xx | retry same key | no cached 5xx replay; recovery first |
| validation 4xx | corrected payload/same key | mismatch or fresh according to policy |

The important property is not that every retry returns a 201. It is that no
retry can create a second provider instruction for the same business operation.

## Testing strategy

The payout integration suite should use a real middleware instance and a fake
repository that follows the same query/save contract. Tests should cover:

- first request with and without a key;
- identical concurrent requests;
- different payloads racing on one key;
- different actors racing on one key;
- response persistence before the waiting request proceeds;
- provider timeout and 5xx behavior;
- success after a timeout during reconciliation;
- permanent provider failure;
- database save failure and retry;
- outbox entry and audit correlation preservation; and
- key expiry and cleanup.

Assertions must count provider executor calls, not only HTTP status codes. Two
201 responses can still be a bug if the provider mock was called twice.

## Operational metrics

Track at least:

- idempotency key hits;
- mismatch rejections;
- requests waiting on an in-flight key;
- lock wait duration;
- save failures;
- ambiguous provider responses;
- reconciled sent operations;
- permanent payout failures; and
- duplicate provider-instruction alerts.

Alert when the waiting count, save failures, or ambiguous responses rise. A high
duplicate-hit rate may be normal during a provider incident, but a provider
executor call count greater than one per business key is always investigation-
worthy.

## Deployment considerations

The keyed barrier is process-local and is safe to roll out behind multiple
workers because it does not change the durable response schema. During a rolling
deployment, requests can land on different workers; the database uniqueness and
settlement constraints must remain enabled. A future durable reservation should
be deployed before enabling provider retries across workers.

Do not clear idempotency rows during deployment. Deleting them reopens old keys
and can turn a delayed client retry into a new payout instruction. If retention
requires cleanup, use the configured expiry policy and retain provider
reconciliation evidence for ambiguous requests.

## Backward compatibility

Requests without an idempotency key retain the existing behavior for clients
that have not migrated. They do not receive the duplicate guarantee and should
be restricted to operations where the business transaction hash or provider
identity provides an independent idempotency boundary.

Requests with keys retain actor and payload binding, response replay, expiry,
and 5xx non-caching semantics. The new barrier only changes the timing of a
concurrent same-key request: it waits for the first request's persistence rather
than executing in parallel.

## Rollback

If the barrier must be disabled, keep the durable idempotency table, unique
constraints, payout records, outbox, and audit fields intact. Before rollback,
drain or quarantine in-flight payout workers and reconcile keys whose response
save failed. Re-enabling the barrier later is safe only when durable state is
preserved.

Do not roll back by deleting rows, resetting key TTLs, or generating new keys
for requests that already reached a provider. Those actions make a duplicate
instruction more likely and destroy the evidence required for reconciliation.

## Security review checklist

- [ ] Same-key requests are serialized until response persistence.
- [ ] Lock release is safe on success, error, and connection close.
- [ ] Actor and payload binding is checked before replay.
- [ ] 5xx responses are not cached as successful payout results.
- [ ] Provider ambiguity is reconciled before a new instruction.
- [ ] Durable database uniqueness remains enabled.
- [ ] Outbox and audit correlation survive retries.
- [ ] Metrics count provider calls, not only HTTP responses.
- [ ] Expiry cleanup does not remove active reconciliation evidence.
- [ ] Rollback preserves idempotency and provider state.

## Database and outbox reconciliation

The durable payout record, idempotency record, and outbox record have different
responsibilities. The payout record represents the business operation, the
idempotency record represents the client retry contract, and the outbox record
represents downstream delivery. They should be linked by one correlation ID and
one business operation identity.

On a successful transaction, the database write and outbox insertion should be
committed together where the repository supports a transaction. Publishing to a
provider occurs after the durable state exists. If the provider call fails, the
worker updates the existing operation state and schedules the same outbox
identity according to its retry policy; it does not create a second payout row.

If the process crashes after the database commit but before provider delivery,
the outbox worker resumes the existing operation. If it crashes after provider
delivery but before the local status update, reconciliation uses the provider
reference and idempotency key. These two crash windows require different
recovery actions and should be visible in metrics.

## Provider adapter contract

Every provider adapter should accept a stable operation identity and return a
structured outcome:

```text
accepted(reference)
already_accepted(reference)
retryable_failure(error_class)
permanent_failure(error_class)
ambiguous(reference_hint)
```

The adapter must not map an ambiguous network error to `permanent_failure` or
silently generate a new provider key. `already_accepted` is a successful
reconciliation outcome and should update the existing durable record without
creating a new outbox event.

Provider errors written to audit or outbox metadata must be normalized and
redacted. Store stable error classes and provider references, not raw responses
that may contain credentials or personal data.

## Lease and worker recovery

If a multi-worker outbox processor claims an operation, the claim needs an
owner, lease expiry, attempt number, and heartbeat. A worker that loses its
lease must stop provider calls for that operation. A new worker may reclaim an
expired lease only after checking the provider reference and operation state.

The in-process HTTP barrier does not replace an outbox lease. It protects the
short request race; the durable worker controls retries that outlive the HTTP
request. Both layers must use the same operation identity so a retry from a
worker cannot bypass the request-level idempotency record.

## Audit requirements

At minimum, the audit context for a payout includes:

- actor or API-key owner;
- idempotency key and payload hash;
- business payout ID;
- outbox event ID;
- provider reference when available;
- operation state before and after the attempt;
- normalized outcome class; and
- request correlation ID.

The original accepted attempt and all later retries should be distinguishable,
but they must point to the same business operation. A duplicate retry is not a
new payout event. A reconciliation event may be new audit evidence while still
referencing the original operation.

## Data retention

Retaining only the response cache is insufficient for ambiguous provider
operations. Keep the business operation, provider reference, audit context, and
reconciliation state for the configured financial retention period. Expiring a
client idempotency key does not authorize a new provider instruction if the
underlying operation remains unresolved.

Cleanup jobs must select records by explicit state and expiry policy. They should
skip `ambiguous`, `processing`, and `reconciliation_required` operations unless
an approved archival workflow has copied the evidence. Cleanup metrics should
include skipped unresolved operations so operators can distinguish normal
retention from stalled payout recovery.

## Incident response

When a duplicate payout is suspected:

1. freeze new retries for the operation identity;
2. collect request, idempotency, payout, outbox, audit, and provider records;
3. compare payload hashes and actor bindings;
4. determine whether one or multiple provider references exist;
5. preserve all records before any compensation action;
6. escalate financial remediation to the approved owner; and
7. document the final state using the original correlation ID.

Do not delete the idempotency row to “allow the retry.” That removes evidence
and can increase the financial loss. If compensation is needed, create a
separate explicitly authorized operation with a distinct audit action.

## Change review checklist

Reviewers should inspect the lock lifecycle, not only the happy-path replay:

- Is the key computed after authentication?
- Can a waiting request observe the durable response before proceeding?
- Does every error and connection-close path release the slot?
- Can one release accidentally unlock a later owner?
- Are actor and payload mismatches rejected before response replay?
- Are provider calls counted independently from HTTP responses?

The focused lock tests exercise acquisition, queue ordering, independent keys,
idempotent release, and release after failure. Integration tests should continue
to cover the full Express response interception because lock correctness and
database persistence are coupled at the response boundary.

Any future distributed reservation must preserve these same observable
properties: one owner at a time, durable completion before replay, explicit
ambiguity, and recovery evidence that points to the original business key.

Changing the reservation semantics requires a migration plan and a provider
reconciliation drill before it is enabled for production payout traffic.

The migration must be observable, reversible, and owned by the payments team.
