# Alert Routing Pipeline

**Audience:** contributors adding or modifying alert rules.

This doc traces a single alert from the metric that fires it, through the routing decision, to the channel or pager it lands in. Read this before touching `monitoring/prometheus/alerts.yml` or `monitoring/prometheus/alertmanager.yml`.

For on-call response procedures and SLA expectations, see [docs/alert-routing.md](./alert-routing.md).

---

## Pipeline at a glance

```
App code                 Prometheus               AlertManager            Delivery
─────────────────────    ─────────────────────    ──────────────────────  ──────────────────────
src/ emits metrics  →    scrapes /metrics (10s) → evaluates alerts.yml → routes via alertmanager.yml
                         evaluates rules (30s)     (PromQL threshold)     → PagerDuty  (SEV1 prod)
                                                                           → Slack      (SEV2/3 prod)
                                                                           → Slack      (staging/dev)
```

---

## Stage 1 — Metric emission (app code)

Prometheus can only evaluate what the app exposes. The relevant emitters are:

| File | What it exposes |
|---|---|
| `src/observability/customMetrics.ts` | `http_requests_status_total`, `http_request_duration_seconds`, `identity_verifications_total`, `bulk_verifications_total` |
| `src/observability/poolMetrics.ts` | `pg_pool_waiting_count{pool="api"\|"worker"}` |
| `src/observability/latencyMetrics.ts` | per-request latency histogram buckets |
| `src/middleware/latencyMetrics.ts` | records duration per route on every request |
| `src/jobs/auditChainVerifier.ts` | `audit_chain_integrity_violation_total`, `audit_chain_verifier_last_run_timestamp` |

All metrics land at `GET /metrics`. Prometheus scrapes that endpoint every 10 seconds from `host.docker.internal:3000` (see `monitoring/prometheus/prometheus.yml`).

**If you add a new alert, you must first have a metric.** Use the existing helpers in `src/observability/` rather than adding a new dependency.

---

## Stage 2 — Alert rule evaluation (`monitoring/prometheus/alerts.yml`)

Prometheus re-evaluates every rule in `alerts.yml` every 30 seconds. A rule fires when its PromQL expression returns a non-empty result for longer than its `for:` guard.

**Real example — the `PgPoolSaturation` alert:**

```yaml
- alert: PgPoolSaturation
  expr: |
    pg_pool_waiting_count{job="credence-backend", pool="api"} > 0
  for: 2m
  labels:
    severity: SEV2
    service: database
    team: infrastructure
  annotations:
    summary: "PostgreSQL connection pool saturated"
    description: >-
      API pool has {{ $value }} requests queued waiting for a
      connection for >2 minutes. Consider increasing DB_POOL_MAX
      or investigating slow queries.
    runbook_url: "https://docs.credence.org/runbooks/database#pool-saturation"
```

What each field does in routing:

| Field | Routing effect |
|---|---|
| `severity` | Primary routing key. Must be `SEV1`, `SEV2`, or `SEV3`. |
| `service` | Used by inhibition rules to suppress noise. Must be one of the values in `VALID_SERVICES` (see `monitoring/validators/alert-config.test.ts`). |
| `team` | Determines on-call ownership. Must be `platform`, `infrastructure`, or `finance`. |
| `for:` | Minimum firing duration before AlertManager is notified. Prevents flapping. Never omit this. |
| `runbook_url` | Must be `https://docs.credence.org/runbooks/…`. The CI validator rejects bare HTTP or missing URLs. |

**Severity selection guide:**

- **SEV1** — data loss, complete service failure, or SLO breach requiring immediate action. AlertManager pages PagerDuty within 5 seconds.
- **SEV2** — degradation that a human should address within 30 minutes but does not require waking anyone up. Creates a Slack ticket.
- **SEV3** — low-signal noise or slow-burn trend. Batched into a maintenance channel, resolved during business hours.

Current severity assignments are validated by `monitoring/validators/alert-config.test.ts`. If you assign `SEV1` to `service: api-platform`, the `should assign platform team to application alerts` test will catch a team mismatch; fix both together.

---

## Stage 3 — Routing decision (`monitoring/prometheus/alertmanager.yml`)

AlertManager receives a fired alert (a set of labels + annotations) and walks its route tree to pick a receiver. The decision is deterministic and label-driven.

**Decision tree (simplified):**

```
alert arrives
  │
  ├─ environment=prod
  │     ├─ severity=SEV1  → pagerduty-prod-critical   (group_wait: 5s, repeat: 30m)
  │     │     ├─ service=trust-score    → pagerduty-prod-critical
  │     │     └─ service=settlement     → slack-prod-settlement-team
  │     ├─ severity=SEV2  → slack-prod-alerts          (group_wait: 2m, repeat: 2h)
  │     └─ severity=SEV3  → slack-prod-low-priority    (group_wait: 5m, repeat: 6h)
  │
  ├─ environment=staging
  │     ├─ severity=SEV1  → slack-staging-alerts       (group_wait: 1m)
  │     ├─ severity=SEV2  → slack-staging-alerts       (group_wait: 3m)
  │     └─ severity=SEV3  → slack-staging-low-priority (group_wait: 10m)
  │
  └─ environment=dev|test → slack-dev-alerts           (group_wait: 5m)
```

**Inhibition rules** prevent alert storms. When a higher-severity alert fires, lower-severity alerts for the same `service` + `environment` are suppressed automatically:

- SEV1 firing → SEV2 and SEV3 suppressed for same service
- SEV2 firing → SEV3 suppressed for same service
- `MaintenanceWindow` alert firing → SEV1 and SEV2 suppressed for same environment

This means: if `DatabaseDown` (SEV1) fires, `PgPoolSaturation` (SEV2) and `PgWorkerPoolSaturation` (SEV3) are silenced until the outage clears. You do not need to add inhibition logic when writing a new rule — the existing rules cover it automatically as long as `service` and `environment` labels are consistent.

---

## Stage 4 — Delivery (receivers)

Receiver credentials are injected at runtime via environment variables. No secrets live in the config file.

| Receiver name | Target | Env var |
|---|---|---|
| `pagerduty-prod-critical` | PagerDuty | `ALERTMANAGER_PAGERDUTY_SERVICE_KEY_PROD` |
| `slack-prod-alerts` | `#prod-alerts` | `ALERTMANAGER_SLACK_WEBHOOK` |
| `slack-prod-settlement-team` | `#prod-settlement-oncall` | `ALERTMANAGER_SLACK_WEBHOOK` |
| `slack-prod-low-priority` | `#prod-maintenance` | `ALERTMANAGER_SLACK_WEBHOOK` |
| `slack-staging-alerts` | `#staging-alerts` | `ALERTMANAGER_SLACK_WEBHOOK` |
| `slack-staging-low-priority` | `#staging-maintenance` | `ALERTMANAGER_SLACK_WEBHOOK` |
| `slack-dev-alerts` | `#dev-alerts` | `ALERTMANAGER_SLACK_WEBHOOK` |

Never add a receiver with a hardcoded token. The security test in `monitoring/validators/cli-validation.test.ts` scans for `xoxb-` and real PagerDuty key patterns and will fail the build.

---

## How to add a new alert

1. **Ensure the metric exists.** Check `/metrics` on a running instance. If it doesn't exist, add it in `src/observability/`.

2. **Write the rule in `alerts.yml`.** Copy the structure of an existing rule at the same severity. Include all four required labels (`severity`, `service`, `team`, `runbook_url`).

3. **Pick the right `for:` duration.** A minimum of 1 minute is expected for SEV2/SEV3. SEV1 alerts may use shorter durations (e.g., `for: 0m` for audit chain violations that must page immediately).

4. **Run the validators:**

   ```bash
   npm test -- monitoring/validators/alert-config.test.ts
   npm test -- monitoring/validators/cli-validation.test.ts
   ```

   The `alert-config` suite validates every label, annotation, and runbook URL. Fix any failures before pushing.

5. **Optional — validate with CLI tools if installed:**

   ```bash
   promtool check rules monitoring/prometheus/alerts.yml
   amtool check-config monitoring/prometheus/alertmanager.yml
   ```

6. **Test the routing manually** (requires local docker-compose stack):

   ```bash
   # Start AlertManager
   docker-compose up -d alertmanager

   # Fire a test alert with the exact labels your new rule will produce
   curl -X POST http://localhost:9093/api/v1/alerts \
     -H "Content-Type: application/json" \
     -d '[{
       "labels": {
         "alertname": "MyNewAlert",
         "severity": "SEV2",
         "service": "verification",
         "environment": "dev"
       },
       "annotations": {
         "summary": "Test",
         "description": "Verify this lands in #dev-alerts"
       }
     }]'
   ```

   A `dev` environment alert should appear in `#dev-alerts` regardless of severity. Swap to `prod` + `SEV2` to verify `#prod-alerts`.

---

## Failure modes

**Alert defined but never fires in prod**
- The metric may not be emitted with `job="credence-backend"`. Check the Prometheus target label in `prometheus.yml` — the scrape job is `credence-backend`, and all selectors in `alerts.yml` filter by it.

**Alert fires but no notification arrives**
- Check `alertmanager_notifications_failed_total` in Prometheus to see if delivery is erroring.
- Verify the env var for the receiver is set: `echo $ALERTMANAGER_SLACK_WEBHOOK`.
- If the `environment` label is missing from the fired alert, the route tree won't match any branch and the `null` receiver silences it.

**Alert fires in staging but not prod**
- The `environment` label on the incoming alert must match exactly (`prod`, not `production`). The scrape label is set in `prometheus.yml` under `external_labels`.

**Lower-severity alert is never delivered**
- It may be suppressed by an active inhibition rule. Check `http://localhost:9093/#/inhibitions` in the AlertManager UI.

---

## Related documentation

- [docs/alert-routing.md](./alert-routing.md) — on-call rotation, SLA response times, runbook index
- [docs/monitoring.md](./monitoring.md) — Prometheus/Grafana setup and dashboard guide
- [docs/observability.md](./observability.md) — logging and tracing
- [ALERT_ROUTING_TESTING_GUIDE.md](../ALERT_ROUTING_TESTING_GUIDE.md) — step-by-step test and deployment checklist
- [monitoring/README.md](../monitoring/README.md) — local stack setup
