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
