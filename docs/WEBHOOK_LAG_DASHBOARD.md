# Webhook delivery lag dashboard summary

Compact operator-facing Grafana row that answers two questions at a glance:

1. **How old is the oldest queued webhook?**
2. **What fraction of deliveries are succeeding?**

**Audience:** Operators / on-call  
**Scope:** Backend observability only (no frontend)  
**Code:** [`src/metrics/webhookLagDashboard.ts`](../src/metrics/webhookLagDashboard.ts)  
**Related:** [JOBS_RETRY_METRICS.md](JOBS_RETRY_METRICS.md), [RUNBOOK_QUEUE_LAG.md](RUNBOOK_QUEUE_LAG.md), [webhooks.md](webhooks.md)

---

## Why this exists

Webhook deliveries already emit several metrics (`webhook_dlq_size`,
`webhook_delivery_duration`, `jobs_oldest_pending_age_seconds{domain="webhook"}`,
…). On-call still had to assemble them into an answer. This summary
standardises a **two-panel row** with shared SLO fence-posts so every
environment shows the same compact signal.

It does **not** replace the cross-domain `jobs_*` metrics or the outbox
queue-lag runbook — those remain the multi-domain / backlog playbooks.
This row is the webhook-specific “is delivery healthy right now?” strip.

---

## Signals

| Panel | Metric / query | Healthy | Warn | Critical |
|-------|----------------|---------|------|----------|
| **Oldest queued age** | `webhook_queued_oldest_age_seconds` | `< 60s` | `≥ 60s` | `≥ 300s` |
| **Success rate (5m)** | `rate(webhook_delivery_outcome_total[5m])` ratio | `≥ 99%` | `< 99%` | `< 95%` |

Constants live in code so docs, alerts, and tests cannot drift:

| Constant | Default | Meaning |
|----------|---------|---------|
| `WEBHOOK_LAG_SOFT_SECONDS` | `60` | Soft lag SLO (amber) |
| `WEBHOOK_LAG_HARD_SECONDS` | `300` | Hard lag SLO (red) |
| `WEBHOOK_SUCCESS_RATE_SOFT` | `0.99` | Soft success floor |
| `WEBHOOK_SUCCESS_RATE_HARD` | `0.95` | Hard success floor |
| `WEBHOOK_SUCCESS_RATE_WINDOW` | `5m` | Rolling window for the rate panel |

`buildWebhookLagDashboardSummary({ oldestAgeSeconds, succeeded, failed })`
combines both signals into a single `{ status, reason }` traffic light
for tests and any future operator API that wants the same classification.

---

## Metrics

### `webhook_queued_oldest_age_seconds`

- **Type:** Gauge  
- **Labels:** none (by design — see [Security](#security))  
- **Updated by:** `setWebhookQueuedOldestAge(ageSeconds)` from a worker
  scrape loop (pass `0` when the queue is empty).  
- **Side effect:** also mirrors into
  `jobs_oldest_pending_age_seconds{domain="webhook"}` so the
  cross-domain stuck-worker alert stays coherent.

### `webhook_delivery_outcome_total{result}`

- **Type:** Counter  
- **Labels:** `result ∈ {success, failure}` only  
- **Updated by:** `recordWebhookDeliveryOutcome('success' | 'failure')`
  at terminal delivery (after retries are exhausted or the attempt
  succeeds).  
- **Does not** auto-increment `jobs_terminal_outcome_total` — existing
  callsites in `WebhookService` already own that counter; double-
  counting would skew the success rate.

---

## PromQL (canonical)

Exported as `WEBHOOK_LAG_DASHBOARD_PROMQL` in
`src/metrics/webhookLagDashboard.ts` and pinned by unit tests.

### Oldest queued age

```promql
webhook_queued_oldest_age_seconds
```

Fallback when the dedicated gauge has not been scraped yet:

```promql
jobs_oldest_pending_age_seconds{domain="webhook"}
```

### Success rate (5m)

```promql
(
  sum(rate(webhook_delivery_outcome_total{result="success"}[5m]))
  /
  clamp_min(
    sum(rate(webhook_delivery_outcome_total[5m])),
    1e-9
  )
)
```

Alternate (cross-domain counters only):

```promql
(
  sum(rate(jobs_terminal_outcome_total{domain="webhook",outcome="succeeded"}[5m]))
  /
  clamp_min(
    sum(rate(jobs_terminal_outcome_total{domain="webhook"}[5m])),
    1e-9
  )
)
```

`clamp_min(..., 1e-9)` avoids divide-by-zero when the window has no
samples; Grafana should still treat a null / empty series as “n/a”,
matching `computeWebhookSuccessRate` returning `null` for zero attempts.

---

## Compact Grafana layout (375px-equivalent single row)

One row, two panels, no decorative chrome:

```
┌──────────────────────────────┬──────────────────────────────┐
│ Oldest queued age (s)        │ Success rate (5m)            │
│ Stat / gauge                 │ Stat (percent unit)          │
│ thresholds: 60 / 300         │ thresholds: 99% / 95%        │
└──────────────────────────────┴──────────────────────────────┘
```

Optional third sparkline (same row on wide screens only):
`rate(webhook_delivery_outcome_total{result="failure"}[5m])` — failure
rate, not a third status signal.

---

## Sample alert rules

```yaml
groups:
  - name: webhook-lag-dashboard
    rules:
      - alert: WebhookQueuedAgeHigh
        expr: webhook_queued_oldest_age_seconds >= 300
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: Webhook delivery queue lag critical
          description: Oldest queued webhook is {{ $value }}s old (hard SLO 300s). See docs/WEBHOOK_LAG_DASHBOARD.md and docs/RUNBOOK_QUEUE_LAG.md.

      - alert: WebhookSuccessRateLow
        expr: |
          (
            sum(rate(webhook_delivery_outcome_total{result="success"}[5m]))
            /
            clamp_min(sum(rate(webhook_delivery_outcome_total[5m])), 1e-9)
          ) < 0.95
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: Webhook delivery success rate below 95%
          description: Success rate is {{ $value | humanizePercentage }} over 5m. Check DLQ size and subscriber health.
```

---

## Instrumentation checklist

1. From the webhook delivery scrape / outbox poll loop, call
   `setWebhookQueuedOldestAge(ageSeconds)` once per interval
   (`0` when empty).
2. At each terminal delivery outcome, call
   `recordWebhookDeliveryOutcome('success' | 'failure')`
   (`WebhookService.emit` already does this).
3. Keep existing `recordJobDeadLetter('webhook', …)` /
   `recordJobTerminalOutcome('webhook', …)` callsites — they own the
   cross-domain view.
4. Run `npx vitest run src/metrics/webhookLagDashboard.test.ts`.
5. Smoke-check the scrape surface after a delivery:

```bash
curl -s http://localhost:3000/metrics | grep -E '^webhook_(queued_oldest_age_seconds|delivery_outcome_total)'
```

---

## Security

| Rule | Rationale |
|------|-----------|
| **No URL / subscriber / tenant labels** on these two summary metrics | Unbounded cardinality + accidental secret leakage via query strings in URLs |
| **`result` is a closed enum** (`success` \| `failure`) | Prevents label explosion from free-form error strings (use `jobs_dead_letter_total{reason}` for breakdowns) |
| **`/metrics` remains scrape-only** | Bind to internal network / require scraper auth as documented in [monitoring.md](monitoring.md); never expose raw metrics on the public ingress |
| **Summary helpers never log payloads** | `buildWebhookLagDashboardSummary` only accepts numeric counters/ages |
| **Status `reason` strings are static templates** | Safe for operator UIs and alert annotations — no request bodies or secrets |

If a future admin JSON endpoint returns this summary, gate it behind the
existing admin auth scopes (`webhooks:admin` or equivalent) — do not add
an unauthenticated `/api/webhook-lag` route.

---

## Triage quick path

| Observation | Likely cause | Next step |
|-------------|--------------|-----------|
| Age rising, success rate flat/high | Worker stuck / not polling | [RUNBOOK_QUEUE_LAG.md](RUNBOOK_QUEUE_LAG.md) Step 2 |
| Age flat, success rate dropping | Subscriber errors / timeouts | Check `webhook_dlq_size`, mTLS failures, subscriber status |
| Both degrading | Saturated pool or upstream outage | [QUEUE_MONITORING.md](QUEUE_MONITORING.md) + subscriber status page |
| Age `0`, success rate `n/a` | Idle system (no deliveries) | Healthy — do not alert on null rate |

---

## Test coverage

`src/metrics/webhookLagDashboard.test.ts` pins:

- Metric name contract + PromQL snippets  
- Gauge clamping / mirror into `jobs_oldest_pending_age_seconds`  
- Counter label cardinality (`result` only)  
- Pure success-rate + lag classification + combined summary status
