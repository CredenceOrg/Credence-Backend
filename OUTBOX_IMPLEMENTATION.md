Outbox implementation notes

This document describes the bounded retries, exponential backoff, and dead-letter handling implemented in the `event_outbox` subsystem.

Schema changes

- `next_attempt_at TIMESTAMPTZ`: newly added column used to schedule the earliest time an event is eligible for retry.
- `status` allowed values now include `dead_letter` to represent a terminal, non-retriable state.

Behavior

- On publish failure the repository's `markFailed()` increments `retry_count`, records the `error_message`, clears any consumer/lease fields, and sets `next_attempt_at` using an exponential backoff formula: `NOW() + 2^(retry_count + 1) seconds`.
- When `retry_count + 1 >= max_retries` the event transitions to `dead_letter` and `processed_at` is set to the current time.
- `claimEvents()` selects only events whose `next_attempt_at` is NULL or in the past, preserving ordering among selected events by `created_at`.

Operational notes

- Dead-lettered events are counted by the `outbox_dead_letter_total{error_code}` Prometheus counter (if `prom-client` is available). This helps alert on sustained failures.
- Reprocessing or manual inspection can be done by querying rows with `status = 'dead_letter'`.
- Cleanup policies still apply — retention configuration controls when published/failed/dead-letter events are removed.

Migration

- A migration `007_outbox_bounded_retries.ts` adds the `next_attempt_at` column, updates the `status` check constraint to include `dead_letter`, and creates an index on `next_attempt_at` for efficient selection of due events.

Testing

- Unit tests cover exact-at-max transitions, due/not-due selection, and ordering preservation when older events are backed off.

