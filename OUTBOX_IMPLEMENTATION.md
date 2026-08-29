Outbox implementation notes

This document describes the bounded retries, exponential backoff, and dead-letter handling implemented in the `event_outbox` subsystem.

Schema changes

- `next_attempt_at TIMESTAMPTZ`: newly added column used to schedule the earliest time an event is eligible for retry.
- `status` allowed values now include `dead_letter` to represent a terminal, non-retriable state.

Behavior

- On publish failure the repository's `markFailed()` increments `retry_count`, records the `error_message`, clears any consumer/lease fields, and sets `next_attempt_at` using an exponential backoff formula: `NOW() + min(2^(retry_count + 1), 3600) seconds`. The delay is capped at 3600 seconds (1 hour) so a large `max_retries` budget can't push the next attempt days into the future.
- When `retry_count + 1 >= max_retries` the event transitions to `dead_letter` and `processed_at` is set to the current time.
- `claimEvents()` selects only events whose `next_attempt_at` is NULL or in the past, preserving ordering among selected events by `created_at`.
- `retry_count` is the attempt counter referenced elsewhere as "attempt count" — there is no separate `attempt_count` column; the existing `retry_count`/`max_retries` pair already track it and is used throughout the codebase, so it was kept rather than introducing a duplicate column.

Error message sanitization

- Before `markFailed()` persists `error_message`, it is passed through `sanitizeErrorMessage()` (`src/db/outbox/errorSanitizer.ts`):
  - Known secret/PII shapes are redacted: Stellar secret seeds, `Authorization`/`Bearer` header values, JWTs, `api_key=`/`token=`/`secret=`-style key-value pairs (key name preserved, value redacted), and email addresses.
  - Redaction runs **before** truncation so a secret straddling the length limit is never left partially exposed.
  - The result is capped at 2000 characters, with a `...[truncated]` suffix when the input was longer.
- This guards against upstream publish errors (e.g. an HTTP client echoing a request's `Authorization` header in its exception message) leaking credentials into the `event_outbox` table or downstream logs/alerts.

Operational notes

- Dead-lettered events are counted by the `outbox_dead_letter_total{error_code}` Prometheus counter (if `prom-client` is available). This helps alert on sustained failures.
- Reprocessing or manual inspection can be done by querying rows with `status = 'dead_letter'`.
- Cleanup policies still apply — retention configuration controls when published/failed/dead-letter events are removed.

Migration

- A migration `007_outbox_bounded_retries.ts` adds the `next_attempt_at` column, updates the `status` check constraint to include `dead_letter`, and creates an index on `next_attempt_at` for efficient selection of due events.

Testing

- Unit tests cover exact-at-max transitions, due/not-due selection, and ordering preservation when older events are backed off.
- `src/db/outbox/__tests__/outbox.retries.test.ts` additionally covers: the backoff delay being capped at 3600s for a high retry count, and `error_message` being sanitized (secret redacted, no raw secret bytes) before it's persisted by `markFailed()`.
- `src/db/outbox/errorSanitizer.test.ts` covers `sanitizeErrorMessage()` in isolation: Stellar secret seeds, Bearer tokens, `Authorization` header values, JWTs, `api_key=`-style params, and email addresses are redacted; messages under/over the length cap are left unchanged/truncated respectively; and a secret positioned anywhere in the string (not just at index 0) is fully redacted with no artifact leaking into the output.

