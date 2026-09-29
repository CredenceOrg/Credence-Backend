# Background Job Crash Recovery

This guide describes how Credence background work resumes after a process crash, pod restart, or forced shutdown. It is written for operators and contributors reviewing outbox, report, webhook, replay, and scheduler changes.

## Recovery Surfaces

| Worker surface | Crash signal | Recovery mechanism | Source |
| --- | --- | --- | --- |
| Transactional outbox publisher | A process dies after claiming rows with `status = 'processing'` | Claims carry `consumer_id` and `lease_expires_at`; the next publisher can reclaim rows whose lease expired | `src/db/outbox/repository.ts`, `src/db/outbox/publisher.ts` |
| Outbox publish side effects | A process dies after publishing but before marking the event published | `publish_idempotency_key` is set before publish; a later consumer skips duplicate publish and moves the row to `published` | `src/db/outbox/publisher.ts`, `src/db/outbox/repository.ts` |
| Outbox retry failures | Publish throws or a downstream dependency is unavailable | `markFailed()` clears consumer and lease fields, increments `retry_count`, computes `next_attempt_at`, and eventually moves exhausted rows to `dead_letter` | `src/db/outbox/repository.ts` |
| Poison outbox payloads | Payload JSON is malformed, too large, unknown, or schema-invalid | The publisher moves the row to `outbox_quarantine` instead of retrying forever | `src/db/outbox/publisher.ts`, `src/db/outbox/repository.ts` |
| Graceful shutdown | `SIGTERM` or `SIGINT` arrives while jobs are running | Shutdown stops listeners/schedulers, stops the outbox job, releases outbox claims, closes pools, and disconnects Redis inside the grace window | `src/gracefulShutdown.ts`, `README.md#graceful-shutdown` |
| Report worker | A report job remains `RUNNING` past the lease timeout | `recoverStuckJobs()` returns old `RUNNING` rows to `QUEUED` so a later worker can retry them | `src/jobs/reportWorker.ts` |
| Background DB connections | Worker tasks contend with API traffic | `workerPool` is separate from the primary pool and has its own sizing and timeout configuration | `src/db/pool.ts`, `README.md#configuration` |

## Outbox Recovery Flow

1. Business code writes domain state and inserts an outbox row in the same transaction through `OutboxEventEmitter.emit()`.
2. `OutboxPublisher` claims pending rows with a unique `consumerId` and a lease window.
3. While running, the publisher renews leases on rows it still owns.
4. Before publishing, it writes a deterministic publish idempotency key. If the process crashes after the downstream publish but before `markPublished()`, the next consumer sees the key and avoids a duplicate side effect.
5. On publish failure, `markFailed()` clears the claim, increments `retry_count`, and schedules the next attempt with capped exponential backoff.
6. If retries are exhausted, the row moves to `dead_letter` and emits terminal retry metrics.
7. On graceful shutdown, `OutboxPublisher.stop()` calls `releaseClaims()` so another consumer can pick up rows immediately instead of waiting for lease expiry.

## Report Worker Recovery Flow

`ReportWorker.recoverStuckJobs()` is the explicit recovery hook for reports. It finds report rows still marked `RUNNING` after the five-minute lease window and returns them to `QUEUED`. A later `processNextQueued()` call can then claim and run the job again. Status transitions invalidate the `report:{jobId}` cache after each repository update.

## Operator Checklist

- Check outbox queue depth and oldest pending lag in the queue monitoring runbook.
- Verify the publisher heartbeat metric is moving before assuming rows are stuck.
- Inspect `processing` rows with expired `lease_expires_at`; these are safe to reclaim by another publisher.
- Inspect `dead_letter` and `outbox_quarantine` separately. Dead-letter rows exhausted retries; quarantine rows failed structural validation and need payload repair before reinjection.
- Confirm shutdown logs include the `outbox_stop`, `pool_close`, and `redis_close` phases before treating a restart as clean.
- For report jobs, compare `updated_at` with the five-minute recovery window before manually changing status.

## Contributor Checklist

- New background workers should use a claim/lease/release pattern or document why the job is naturally idempotent.
- Any side effect that can reach an external service should have an idempotency key before the side effect fires.
- Failure handlers must clear ownership fields before retry so a different worker can pick up the job.
- Poison payloads should be quarantined or failed fast instead of retried until the queue is saturated.
- Shutdown paths should stop new work first, then wait briefly for in-flight work, then release claims or close resources.
- Add tests for the happy recovery path and one explicit failure mode, such as expired lease reclaim, idempotency-key resume, retry-to-dead-letter, or stuck report recovery.

## Related Docs

- [RUNBOOK_QUEUE_LAG.md](RUNBOOK_QUEUE_LAG.md)
- [REPLAY_SAFE_HANDLERS.md](REPLAY_SAFE_HANDLERS.md)
- [timeouts-and-retries.md](timeouts-and-retries.md)
- [QUEUE_MONITORING.md](QUEUE_MONITORING.md)
