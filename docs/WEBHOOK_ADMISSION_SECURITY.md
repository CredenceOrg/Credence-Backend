# Webhook admission security

Inbound webhook admission binds the tenant, immutable provider event ID,
ledger timestamp, and exact raw request bytes into an HMAC-SHA256 signature.
Verification happens before the idempotency store is claimed. Expired or
future-skewed events therefore cannot reserve state, and a malformed or
tampered request cannot reach a business mutation.

The in-memory store uses `(tenantId, eventId)` as its identity and stores only a
body fingerprint plus the final status/body. A same-tenant replay returns the
original outcome; a changed payload returns a conflict. The same provider event
ID can be used by another tenant without crossing the isolation boundary.

The store interface is intentionally replaceable. A production multi-process
deployment should use a transaction-backed implementation whose claim is an
atomic insert-if-absent and whose business mutation and outcome record commit
together. The shipped implementation is deterministic and appropriate for
single-process tests/development; it does not pretend to be cross-process
durability.

Signatures use the explicit `v1:` layout so future algorithms can introduce a
new version without making old signed payloads ambiguous. Raw bytes are used,
not parsed/re-serialized JSON. Error messages are stable and do not include
secrets or provider payloads.

The focused suite covers exact-byte tampering, tenant/event binding, malformed
signatures, timestamp boundaries, replay, conflict, tenant isolation, expiry,
status replay, completion mismatch, and pre-claim failure behavior.

## Verification order

1. Validate tenant and provider event identity.
2. Validate the timestamp representation and acceptance window.
3. Recompute the HMAC over the exact bytes received from the transport.
4. Compare the supplied digest in constant time.
5. Atomically claim `(tenantId, eventId, fingerprint)`.
6. Execute the business mutation and complete the outcome record.

The ordering is important. A failed signature or stale timestamp must not leave
an idempotency tombstone that prevents a legitimate retry. Conversely, a valid
request must claim before the mutation begins so two workers cannot both apply
the same provider event. A conflict is not treated as a replay because a
provider event ID is immutable and a changed payload needs operator review.

## Threat model

| Threat | Control | Regression coverage |
| --- | --- | --- |
| body whitespace or encoding change | raw-byte HMAC | exact body fixtures |
| copied signature across tenants | tenant in preimage and store key | tenant mutation tests |
| copied signature across events | event ID in preimage | event mutation tests |
| stale delivery | bounded ledger-clock window | past/future matrix |
| duplicate delivery | atomic claim and stored outcome | replay tests |
| changed retry payload | body fingerprint conflict | conflict tests |
| timing oracle | constant-time digest compare | fixed-length path |
| secret disclosure | fingerprint-only record and generic errors | leakage tests |

## Deployment notes

The in-memory store is intentionally explicit about its process boundary. It
is useful for local development and deterministic unit tests, but a horizontally
scaled production deployment must inject a database-backed store. The shared
implementation should use a unique constraint over tenant and event identity,
store the fingerprint and final response in the same transaction as the
business mutation, and provide a recovery path for a worker that crashes after
claim but before completion.

A recovery path must distinguish a retriable processing lease from a completed
outcome. Deleting an arbitrary record on timeout can permit duplicate effects;
recovery should use a lease owner, expiry, and an application-level mutation
key so the business transaction remains idempotent. The pure admission contract
does not silently claim to solve cross-process durability.

## Operational review

Operators should monitor invalid signatures, timestamp failures, conflicts,
replays, and completed admissions independently. A spike in replays can be a
provider retry storm; a spike in conflicts can indicate a provider bug or an
attack; a spike in timestamp failures can indicate clock drift. Metrics should
contain tenant-safe aggregates only and must never log raw bodies, signatures,
or secrets.

Secret rotation must retain an explicit versioned verification policy. During a
planned grace period, the caller may verify with the active and previous secret
according to the rotation service, but the event ID and raw-body binding must
not change. Once the previous secret expires, old deliveries are rejected
without reserving a new admission record.

The test matrix is designed to remain useful during future refactors: it tests
observable security invariants at the public admission boundary rather than
private implementation details. Any replacement store or signature adapter
must keep these outcomes and error codes stable.

## Backward compatibility

The admission helper is additive and does not alter existing outbound delivery
signatures. Existing callers can adopt it at an ingress boundary, while the
current delivery service continues to use its configured provider contract.
The explicit `v1` material layout leaves room for a migration adapter when a
provider needs a different header format.

No database migration is required for the in-memory implementation. A shared
store rollout should introduce its schema behind a feature flag, dual-read
only after the new unique constraint is verified, and retain an operator
rollback path. The correctness invariant is that one event identity has one
committed outcome per tenant.

Reviewers should verify that every ingress caller passes the raw body before
JSON parsing and uses the authenticated tenant context rather than a tenant
field supplied inside the payload. They should also confirm that provider
event IDs are treated as opaque strings and are not normalized in a way that
turns two distinct IDs into one key.

When an event is accepted, the mutation layer should carry the admission
record's tenant and event identity into its audit entry. This makes a replay
visible without storing another copy of the payload. When a conflict is
reported, the operator-facing audit record should contain the two fingerprints
and the event identity, while keeping both raw bodies out of logs.

The final response is part of the replay contract. A retry must receive the
same status and serialized result that the first successful processing chose.
If business processing fails, the caller should complete the record with a
typed failure outcome or release a well-defined lease; it must not claim
success merely because the signature was valid.

The admission boundary is deliberately independent from delivery retries.
Outbound retries may use their own subscriber/event key, but an inbound
provider event must be admitted once before it changes local state.

### Incident response

If signature failures rise, rotate the affected provider secret and inspect
the tenant-scoped audit counters. If conflicts rise, compare provider event
payload generation with the immutable event identifier. If replay volume rises
without corresponding provider retries, investigate duplicate ingress or a
misconfigured worker.

The verifier clock should be synchronized and monitored. A clock correction
must not widen the acceptance window silently; changing tolerance is a policy
change and should be reviewed as a security-sensitive configuration update.

The tests intentionally avoid real secrets and network calls. CI can run them
without credentials, while integration environments can inject a real store
and transport adapter behind the same typed interface.
