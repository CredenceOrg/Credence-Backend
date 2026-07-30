# Notifications Failover

## Overview

The notifications delivery pipeline now supports ordered provider failover with bounded retries, exponential backoff, jitter, shared provider health tracking, and DLQ routing.

The public notification API stays the same:

- `NotificationService.send()`
- `NotificationService.sendBatch()`
- `deliverNotification()`

## Delivery Flow

1. Build the ordered provider chain from the configured provider map.
2. Consult shared provider health and push unhealthy providers to the back of the chain.
3. Persist a pending send attempt before each provider call.
4. Fail over immediately on transient provider errors such as `5xx` and network failures.
5. Apply exponential backoff with jitter after each full provider sweep when attempts remain.
6. Route exhausted or ambiguous deliveries to the notification DLQ.

## Idempotency

Notification delivery reuses the shared job idempotency pattern from `src/jobs/notificationIdempotency.ts`.

- Successful deliveries are cached under `notification_delivery:<notificationId>`.
- Replays after success return a deduped result instead of sending again.
- Failed executions are not cached as successful and may be retried later.
- Provider attempts still get their own persisted send-attempt idempotency keys for auditability.

### The claim

A retryable job may be redelivered at any time — worker crash, visibility-timeout expiry, manual replay — so the guarantee cannot rest on in-process state. It is one row in `idempotent_job_attempts` keyed by `job_key`, claimed with a single statement:

```sql
INSERT INTO idempotent_job_attempts (...) VALUES (...)
ON CONFLICT (job_key) DO UPDATE SET status = 'pending', ...
WHERE <reclaimable>
RETURNING ...
```

Because the conditional upsert and the claim check are the *same* statement, two workers racing on one `job_key` cannot both win: Postgres serialises them on the unique index and only the winner receives a `RETURNING` row. A caller that gets no row must not run the job — it either returns the recorded result (`completed`) or reports a duplicate in flight.

A row is reclaimable only when:

| Condition | Why |
| --- | --- |
| `status = 'failed'` | the previous attempt released its claim; retry immediately |
| `expires_at <= NOW()` | the dedup window (`expiresInSeconds`, default 24h) has lapsed |
| `status = 'pending'` and `attempted_at` older than the claim lease | the worker holding it died |

A `completed` row inside its TTL is never reclaimable — that is what makes a replay return the stored result instead of sending a second email.

### Claim lease

`DEFAULT_CLAIM_TIMEOUT_SECONDS` (15 minutes) bounds how long a `pending` claim blocks other workers. Without it a worker that crashed mid-send would hold the claim for the full 24-hour TTL and every retry would be rejected, so the notification would never be delivered. The lease must comfortably exceed worst-case delivery duration (provider timeout × failover attempts × backoff) so a still-running send is never reclaimed underneath itself.

On reclaim the row's `id` is rotated. `markCompleted`/`markFailed` target the `id` the worker claimed, so a zombie worker returning late cannot mutate a row that has since been reclaimed by someone else.

### Schema requirement

The unique constraint must be on `job_key` **alone**. A composite key such as `UNIQUE (job_key, expires_at)` breaks this two ways: `ON CONFLICT (job_key)` can no longer be inferred (Postgres raises `42P10` on every execution), and two live rows can exist for the same job. See `src/migrations/032_create_idempotent_job_attempts.ts`.

### Testing note

pg-mem ignores the `WHERE` clause on `ON CONFLICT ... DO UPDATE` — it applies the update regardless — so it cannot validate the guard. Unit tests in `src/jobs/notificationIdempotency.test.ts` model the statement's Postgres semantics explicitly; `tests/integration/notificationIdempotency.integration.test.ts` re-verifies them against a real Postgres and is skipped unless `TEST_DATABASE_URL` is set.

## Timeout Edge Case

Timeouts are treated as ambiguous outcomes rather than safe failover signals.

- The provider may have accepted the message even if the client timed out.
- The pipeline does not fan out to another provider after an ambiguous timeout.
- The notification is pushed to DLQ for reconciliation instead of risking a duplicate send.

## DLQ Shape

The notification DLQ follows the existing webhook DLQ style:

- Captures the original notification payload.
- Records the ordered providers considered.
- Stores each failed attempt with provider, attempt number, idempotency key, and error metadata.
- Persists the final failure reason and DLQ timestamp.

## Prometheus Metrics

The pipeline emits the following counters through `prom-client`:

- `notification_provider_attempts_total{provider,outcome}`
- `notification_provider_success_total{provider}`
- `notification_failovers_total{from_provider,to_provider}`
- `notification_dlq_total{reason}`

Per-provider success rate can be derived from:

- `notification_provider_success_total / notification_provider_attempts_total`

## Test Coverage

Focused notification tests cover:

- primary provider down -> secondary provider used
- all providers down -> notification routed to DLQ
- retry after a successful failover -> no duplicate send
- unhealthy provider deprioritized on later deliveries

## Gradual Recovery (Thundering Herd Protection)

When a provider's cooldown expires, it does not immediately return to full health.
Instead it enters a **recovering** state for `PROVIDER_RECOVERY_BUFFER_MS` (default 5 seconds).

### Provider ordering tiers

1. **Healthy** — no recent failures or past the recovery buffer.
2. **Recovering** — cooldown just expired; still within the recovery buffer.
3. **Unhealthy** — still within the cooldown period.

Recovering providers are placed behind fully-healthy providers in the delivery
order but ahead of unhealthy ones. This spreads the re-introduction of traffic
and avoids a thundering herd against a just-recovered provider.

### Configuration

The recovery buffer is configured via the `NotificationProviderHealthTracker`
constructor's `recoveryBufferMs` parameter:

```ts
// Default: 5 000 ms
new NotificationProviderHealthTracker(cooldownMs, failureThreshold, recoveryBufferMs)
```

The default value is exported as `PROVIDER_RECOVERY_BUFFER_MS` from
`src/config/constants.ts`.
