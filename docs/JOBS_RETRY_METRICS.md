# Jobs: Retry Budget Metrics and Dead-Letter Tracking

## Why these metrics exist

The Credence Backend has multiple job domains (outbox events, webhook
deliveries, email notifications, expired-session sweeps, audit-chain
verifier, idempotent-job sweeper, ...) — each with its own bespoke
per-domain metric. Operators responding to *"is anything stuck?"*
alerts previously had to author one PromQL rule per domain:

- `outbox_dead_letter_total{error_code="..."}` (outbox only)
- `webhook_dlq_size` (gauge, no reason label)
- `notification_dlq_total{reason="..."}` (notifications only)
- bespoke `failed_inbound_*` counters (failed events only)

When a new domain ships — and one ships every quarter — alert coverage
silently regresses until somebody notices to add a firing rule. This
module closes that loop by exporting a **small, stable set of generic
metrics with a shared `domain` label**, so one rule surfaces stuck
workers everywhere.

The cross-cutting surface does NOT replace the per-domain metrics; both
stay active and operators can mix and match queries across them.

## Metrics

| Name | Type | Labels | Increments when... |
|---|---|---|---|
| `jobs_dead_letter_total` | Counter | `domain`, `reason` | a job moves to a dead-letter queue (terminal exhaustion) |
| `jobs_terminal_outcome_total` | Counter | `domain`, `outcome ∈ {succeeded, dead_letter}` | a job reaches a terminal state (consumed its retry budget) |
| `jobs_terminal_attempt_count` | Histogram (buckets `1`, `2`, `3`, `5`, `10`, `20`) | `domain` | observed at the moment of terminal outcome |
| `jobs_oldest_pending_age_seconds` | Gauge | `domain` | a worker scrape loop reports the oldest pending age |

`reason` is normalized to an ASCII-uppercase-underscore identifier
(≤ 50 chars, non-alphanumeric chars collapse to `_`, `UNKNOWN` if
empty) so the time-series cardinality stays bounded — every domain
gets at most one series per `reason` token in practice.

`domain` is a closed union (`outbox | webhook | notification` as of
this PR). New domains MUST add their value to the union AND wire at
least one callsite before the metric emits anything — the union is the
source of truth for what label values operators can expect.

## Sample PromQL alerts

```promql
# Stuck worker: oldest pending age > 10 minutes for any domain.
max by (domain) (jobs_oldest_pending_age_seconds) > 600

# Retry budget exhausted rapidly: > 5 dead-letter transitions in 5 min
# on any domain. Tune the threshold per environment.
sum by (domain) (rate(jobs_dead_letter_total[5m])) > 5

# Failure-mode breakdown for a given domain (operator runbook query):
sum by (domain, reason) (rate(jobs_dead_letter_total[15m]))

# Retry budget consumed: how many attempts does the median dead-letter
# job consume? Looks at the histogram bucket ratios for `domain`.
histogram_quantile(0.5, sum by (le, domain) (
  rate(jobs_terminal_attempt_count_bucket[10m])
))
```

## On-call triage playbook

When two or more of these signals fire at once, walk this in order.
Each step tells you the *kind* of incident you are looking at, not just
a number on a graph.

1. **Gauge first — `jobs_oldest_pending_age_seconds` rising.**
   If the oldest pending age grows *without* a corresponding spike in
   dead-letter rate, the worker is stuck (paused queue, lease lost,
   silent crash). Look at the worker host first: CPU, memory, log
   tail, `pg_stat_activity` for long-running transactions. Metrics
   flat-line under this failure mode because transitions stop — the
   gauge is the only signal that catches it.

2. **Then counter — `jobs_dead_letter_total` rate spike.**
   If the counter is climbing while the gauge stays flat, workers are
   actively rejecting work. Group by `reason` to get the failure-mode
   breakdown — `ECONNREFUSED`, `TIMEOUT`, `UNKNOWN` — and route to
   the on-call owner of that dependency.

3. **Then histogram — `jobs_terminal_attempt_count` shifted to high buckets.**
   If most dead-letter jobs landed in `5` or `10` instead of `1`/`2`,
   the **retry budget is too tight** for the workload: jobs that
   *should* succeed on the second or third attempt are being thrown
   away. Either raise the upstream `max_retries` / `max_attempts`,
   or shorten the backoff ceiling so retries land sooner. Always
   check per-domain before changing the global setting.

## How to instrument a new domain

1. Add the new domain name to the `JobDomain` union in
   `src/jobs/retryMetrics.ts`.
2. From every DLQ-push callsite in the new domain, call
   `recordJobDeadLetter('<newdomain>', normalizedReason)`. Use the
   same `reason` string the per-domain metric records so the SLO
   dashboards see the same failure modes.
3. From every terminal-outcome callsite (success OR exhaustion), call
   `recordJobTerminalOutcome('<newdomain>', 'succeeded' | 'dead_letter',
   attempts)` with the actual attempt count (≥ 1). Use the real count;
   clamping to `1` is a temporary fallback for domains that don't yet
   track per-event attempts.
4. From every worker scrape loop, call
   `setJobOldestPendingAge('<newdomain>', ageSeconds)`. Pass `0` when
   the queue is empty so that dashboards can tell "clean" from "stale".
5. Run `npx vitest run tests/jobs/retryMetrics.test.ts` — the tests
   pin the metric names so a future PR that renames any of them must
   intentionally update the contract.

## Why a `oldest_pending_age_seconds` gauge and not just counters

Counters fire on transitions. If a queue is paused, the dispatcher
crashes, or a worker silently drops its lease, transition counters
flat-line to zero — which is *exactly* the state you want to alert on.
A majority of "stuck worker" incidents look like a missing signal,
not a flood of failed signals. The gauge addresses that gap by
asserting *non-monotonic growth*: if the oldest pending age is
non-zero and **does not decrease** over a scrape interval, that's the
strongest stuck-worker signal available before the first failure.

## Verification

```bash
# Typecheck only the touched files:
npx tsc --noEmit 2>&1 | grep -E 'retryMetrics|JOBS_RETRY_METRICS|tests/jobs/retryMetrics'
# → empty (no errors in this PR's files)

# Run the new test suite:
npx vitest run tests/jobs/retryMetrics.test.ts
# → all tests passing

# Quick wire-up smoke test on the actual surfaces:
curl -s http://localhost:3000/metrics | grep -E '^jobs_(dead_letter_total|terminal_outcome_total|terminal_attempt_count_(bucket|count|sum)|oldest_pending_age_seconds)'
# → emits metric families after the wired-in callsites have run
```

## Notes

- These metrics are ADDITIVE. Per-domain metrics (outbox,
  webhooks, notifications, expired-sessions, audit-chain, …) all
  stay active and keep their existing dashboards / alerts.
- The histogram buckets `[1, 2, 3, 5, 10, 20]` capture the typical
  max-retry budget in this codebase (~3–10) without losing the
  long-tail signal for misconfigured workloads. Operators can
  graph `sum by (le) (rate(jobs_terminal_attempt_count_bucket[5m]))`
  to see how consumers are spending their retry budget.
- The `reason` normalization is the single cardinality guard rail
  for cross-cutting metrics. If you need a richer classification,
  add per-domain metrics — don't blow up the cross-cutting label
  set.

## Per-domain observation threads

The histogram observation in this PR is **per-domain accurate**:

| Domain | Source of attempts value at the metric callsite |
|---|---|
| `outbox` | `markFailed(...)` returns `{ status, retryCount }` — the SQL `RETURNING retry_count` clause hands back the *final* count after `retry_count + 1` and the dead-letter transition. The publisher takes that value directly. Operators reading the `outbox` buckets see the actual budget consumed, not a synthetic `1`. |
| `notification` | The `attempts` parameter on `IdempotentEmailDeliveryService.routeToDlq()` is the end-of-cycle attempt count from the provider-failover loop. Whatever value survived the bounded failover is exactly what the histogram samples. |
| `webhook` | `WebhookDeliveryResult.attempts` is REQUIRED in the type. The `WebhookService.emit()` flow reads it once per failed delivery and forwards it; the defensive `?? 1` is there only because earlier (pre-type-strictness) callers have been observed to skip it. |

## See also

- [WEBHOOK_LAG_DASHBOARD.md](WEBHOOK_LAG_DASHBOARD.md) — compact webhook-only Grafana row for oldest queued age + success rate (`webhook_queued_oldest_age_seconds`, `webhook_delivery_outcome_total`). Complements the cross-domain `jobs_*` view above; does not replace it.
- [RUNBOOK_QUEUE_LAG.md](RUNBOOK_QUEUE_LAG.md) — outbox backlog triage when age rises without a matching failure spike.
