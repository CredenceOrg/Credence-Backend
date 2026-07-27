# Blameless Postmortem Template

This template is for **operators and on-call engineers** conducting a blameless post-incident review for the Credence Backend. It captures the timeline, impact, root cause, and action items in a structure that surfaces systemic improvements rather than individual blame.

**Last updated:** 2026-07-25

---

## Quick Reference

| Section | Purpose |
| ------- | ------- |
| [Metadata](#metadata) | Incident identifier, severity, duration |
| [Summary](#summary) | One-paragraph executive summary |
| [Background](#background) | Relevant system context |
| [Timeline](#timeline) | Chronological log of events (UTC) |
| [Impact](#impact) | Users affected, error budget consumed, services degraded |
| [Root Cause Analysis](#root-cause-analysis) | 5 Whys drill-down |
| [Detection](#detection) | How we found it, time to detect |
| [Response & Resolution](#response--resolution) | What we did, what worked, what didn't |
| [Action Items](#action-items) | Preventative, detective, and process improvements |
| [Lessons Learned](#lessons-learned) | What went well, what didn't, surprises |
| [Appendix](#appendix) | Links to dashboards, logs, related docs |

---

## Metadata

| Field | Value |
| ----- | ----- |
| **Incident ID** | `INC-YYYY-NNN` |
| **Date** | YYYY-MM-DD |
| **Duration** | `HHh MMm` (start → resolved) |
| **Severity** | SEV1 / SEV2 / SEV3 |
| **Status** | Resolved / Mitigated / Ongoing |
| **Postmortem Author** | Name or handle |
| **Reviewers** | @handle1, @handle2 |
| **Affected Services** | `credence-backend`, `redis`, etc. |
| **Related Alerts** | Alert names from [alert-routing.md](./alert-routing.md) |

---

## Summary

_One paragraph. State what broke, who was affected, and the business impact in plain language._

**Example:**

Between 14:32 and 15:18 UTC on 2026-07-24, the `POST /api/attestations` endpoint returned HTTP 503 for 42% of requests. The root cause was a saturated database connection pool caused by a missing index on `attestations.identity_id` following a schema migration deployed at 14:15. Read-only endpoints (`GET /api/trust/:address`, `GET /api/bond/:address`) were not affected. The incident consumed 0.03% of the monthly error budget (≈7 hours of burn at the peak rate). No attestation data was lost — writes queued in the outbox and were replayed after the fix.

---

## Background

_One or two paragraphs of context. What does the affected system do? What changed recently (deployment, config, traffic pattern) that contributed to the incident?_

**Example:**

The attestations subsystem persists signed trust claims and publishes them to the outbox for downstream webhook delivery. At 14:15 UTC, migration `migrations/1721_add_attestation_metadata.ts` added a `metadata JSONB` column to the `attestations` table. The migration ran successfully in CI and staging and completed in production in under 3 seconds.

However, the existing query path for `POST /api/attestations` performs a lookup on `attestations.identity_id` to enforce the per-identity attestation cap. This column had no dedicated index — prior to the migration the table was small enough (< 50k rows) that sequential scans finished within the statement timeout. The migration's table rewrite caused PostgreSQL to discard cached query plans, and by 14:32 traffic volume (≈120 POST/min) pushed sequential scans past the 30-second statement timeout, saturating the pool.

---

## Timeline

_All times in UTC. Include detection, diagnosis, mitigation, and resolution. Link to relevant Slack threads, dashboards, or runbook steps._

| Time (UTC) | Event | Notes |
| ---------- | ----- | ----- |
| 14:15 | Migration `1721` applied to production | `npm run migrate` completed successfully |
| 14:32 | `ConnectionPoolSaturation` alert fires (SEV2) | [alert-routing.md](./alert-routing.md) row `api-platform` |
| 14:33 | On-call acknowledges alert in PagerDuty | @oncall-handle |
| 14:35 | Grafana dashboard shows `pg_stat_activity_count` at 20/20 (pool max) | [observability.md](./observability.md) |
| 14:38 | Runbook step: [Connection Pool Saturation](./RUNBOOK.md#connection-pool-saturation) executed | Identified 17 `active` connections running the same `SELECT … WHERE identity_id = $1` query |
| 14:41 | `EXPLAIN ANALYZE` reveals sequential scan on `attestations` (≈48k rows, ~2.8s per scan) | No index on `identity_id` |
| 14:45 | Decision: create index online with `CONCURRENTLY` | Avoids table lock during creation |
| 14:46 | `CREATE INDEX CONCURRENTLY idx_attestations_identity_id ON attestations(identity_id)` | Started |
| 14:52 | Index build completes | `pg_stat_progress_create_index` shows 100% |
| 14:53 | Connection pool recovers — `pg_stat_activity_count` drops to 4 | Postgres picks up the new index immediately |
| 14:55 | Outbox replay initiated for attestations that were queued during outage | `POST /admin/replay-event` per [replay_and_inspection.md](./replay_and_inspection.md) |
| 15:18 | All queued outbox messages delivered; `POST /api/attestations` error rate returns to < 0.1% | Verified via Prometheus: `rate(http_requests_status_total{route="/api/attestations",status_class="5xx"}[5m])` |
| 15:20 | Incident declared resolved | |

---

## Impact

| Metric | Value |
| ------ | ----- |
| **Duration** | 46 minutes (14:32 → 15:18 UTC) |
| **Users affected** | ≈280 POST /api/attestations requests returned 503 |
| **Error budget consumed** | 0.03% of monthly 0.1% error budget |
| **Peak burn rate** | 4.2× (see [SLO.md](./SLO.md#burn-rate)) |
| **Services degraded** | `POST /api/attestations` (writes only) |
| **Services unaffected** | `GET /api/trust/:address`, `GET /api/bond/:address`, `GET /api/health`, `GET /api/attestations/:address` |
| **Data loss** | None — outbox preserved all attestation writes for replay |

---

## Root Cause Analysis

_Root cause is the systemic gap, not the person or the mistake. Use 5 Whys._

### 5 Whys

1. **Why did `POST /api/attestations` return 503?**
   The database connection pool was exhausted — all 20 connections were occupied by slow-running queries.

2. **Why were queries slow?**
   The lookup `SELECT … FROM attestations WHERE identity_id = $1` was doing a sequential scan of 48k rows, taking ~2.8 seconds per query.

3. **Why was there no index on `identity_id`?**
   The column was used in a look-up path but no index was ever created because the table was small enough that sequential scans did not previously violate the statement timeout.

4. **Why did this surface now, after the migration?**
   The migration's table rewrite (`ALTER TABLE … ADD COLUMN`) caused PostgreSQL to discard cached query plans and internal statistics, and by the time auto-vacuum re-analyzed the table, traffic volume had already saturated the pool.

5. **Why wasn't this caught before production?**
   The staging environment has a truncated `attestations` table (< 200 rows), so the sequential-scan pattern was never exercised at production scale. There is no automated check that indexes on foreign-key columns exist for every query path.

### Systemic Root Cause

The absence of a programmatic guardrail that verifies every query path involving a foreign-key column (`identity_id`) has a corresponding index before the migration is applied. The small staging dataset masked the performance regression.

---

## Detection

| Question | Answer |
| -------- | ------ |
| **How was the incident detected?** | `ConnectionPoolSaturation` Prometheus alert (SEV2) fired at 14:32 UTC |
| **Time to detect** | 17 minutes (14:15 deployment → 14:32 alert) |
| **Time to diagnose** | 13 minutes (14:32 alert → 14:45 root cause identified) |
| **Time to mitigate** | 21 minutes (14:32 alert → 14:53 pool recovered) |
| **Time to resolve** | 46 minutes (14:32 alert → 15:18 outbox drained) |
| **Was the alerting effective?** | Yes — `ConnectionPoolSaturation` fired within 2 minutes of pool exhaustion. No SEV1 page was generated because read endpoints remained healthy. |

---

## Response & Resolution

### What went well

- `ConnectionPoolSaturation` alert fired promptly and was acknowledged within 1 minute.
- The [Connection Pool Saturation runbook](./RUNBOOK.md#connection-pool-saturation) had the exact diagnostic queries needed (`pg_stat_activity`, `pg_blocking_pids`).
- Creating the index with `CONCURRENTLY` avoided a table lock and required zero downtime.
- No data was lost — the outbox pattern preserved all attestations for replay.

### What went poorly

- The migration was applied without a dry-run analysis of query performance under production-scale data volume. See [migrate-dry-run.ts](../scripts/migrate-dry-run.ts).
- Staging did not have a representative data volume, so the performance regression was invisible in pre-production testing.
- The pool saturation alert is SEV2 (ticket), not SEV1 (page). This delayed escalation by ~6 minutes while the on-call finished another task.

### What was lucky

- Read endpoints (`GET /api/trust`, `GET /api/bond`) use separate query paths that were unaffected.
- The outbox publisher was buffered and did not lose messages despite the pool saturation.

---

## Action Items

_Prioritize items that prevent this class of incident from recurring. Assign an owner and a target date._

### Preventative (stop this from happening again)

| # | Action | Owner | Target | Status |
| - | ------ | ----- | ------ | ------ |
| P1 | Add `CREATE INDEX CONCURRENTLY idx_attestations_identity_id ON attestations(identity_id)` as a new migration | @handle | YYYY-MM-DD | ☐ Open |
| P2 | Add a **migration safety check** that scans all FK columns referenced in query paths and warns if no index exists — integrate into `scripts/migrate-dry-run.ts` | @handle | YYYY-MM-DD | ☐ Open |
| P3 | Seed staging `attestations` table with production-scale row count (≥ 50k) as part of the test data bootstrap | @handle | YYYY-MM-DD | ☐ Open |

### Detective (catch this faster next time)

| # | Action | Owner | Target | Status |
| - | ------ | ----- | ------ | ------ |
| D1 | Add a Prometheus alert for per-endpoint p95 latency > 1s, scoped to the 5-minute window after any migration completes | @handle | YYYY-MM-DD | ☐ Open |
| D2 | Add a `migrate:dry-run` step to the CI pipeline that runs `EXPLAIN` on all query paths against a production-scale snapshot | @handle | YYYY-MM-DD | ☐ Open |

### Process (improve how we respond)

| # | Action | Owner | Target | Status |
| - | ------ | ----- | ------ | ------ |
| C1 | Promote `ConnectionPoolSaturation` from SEV2 to SEV1 when `pg_stat_activity_count` reaches pool max (currently only fires as SEV2) | @handle | YYYY-MM-DD | ☐ Open |
| C2 | Update the [migration guardrails doc](./MIGRATION_GUARDRAILS.md) to require index-existence verification for FK columns before `npm run migrate` in production | @handle | YYYY-MM-DD | ☐ Open |
| C3 | Schedule a quarterly **failover drill** that simulates pool saturation using the [horizon-failover-drill.ts](../scripts/horizon-failover-drill.ts) script | @handle | YYYY-MM-DD | ☐ Open |

---

## Lessons Learned

- **Indexes on FK columns are load-bearing at scale.** A query that completes in < 10 ms on 200 rows can take 2+ seconds on 50k rows. Production-scale test data in staging is the only reliable way to catch this.
- **Outbox preserved data integrity.** The outbox pattern (see [outbox-quarantine.md](./outbox-quarantine.md)) ensured that even though the pool was saturated, no attestation writes were lost. This is a strong argument for extending the outbox to additional write paths.
- **SEV2 vs SEV1 gating matters.** Because the pool alert is SEV2, the on-call treated it as non-urgent. For resource-exhaustion alerts where recovery requires operator intervention, SEV1 may be more appropriate.
- **Dry-run migrations should include query-plan analysis.** The current `npm run migrate:dry-run` only checks migration SQL syntax. It should also run `EXPLAIN` on all known query templates against the target database. See [MIGRATION_GUARDRAILS.md](./MIGRATION_GUARDRAILS.md).

---

## Appendix

### Relevant Dashboards

- [Grafana: PostgreSQL Pool Utilization](#) — `pg_stat_activity` by state
- [Grafana: Endpoint Latency](#) — p50/p95/p99 per route
- [Prometheus: Error Budget Burn Rate](#) — SLO compliance

### Relevant Runbook Steps Used

- [Connection Pool Saturation](./RUNBOOK.md#connection-pool-saturation)
- [PostgreSQL Down](./RUNBOOK.md#postgres-down) (diagnostic queries only)

### Related Documentation

- [SLO Definitions & Burn Rate](./SLO.md)
- [Migration Guardrails](./MIGRATION_GUARDRAILS.md)
- [Outbox & Quarantine](./outbox-quarantine.md)
- [Replay & Inspection Guide](./replay_and_inspection.md)
- [Alert Routing Matrix](./alert-routing.md)
- [Database Migration Best Practices](../README.md#database-migrations) (root README)
- [Timeout Budgets & Retry Policies](./timeouts-and-retries.md)

---

## Postmortem Completion Checklist

- [ ] All action items have owners and target dates
- [ ] Root cause is systemic (not a person)
- [ ] Timeline is complete and links to Slack threads / dashboards
- [ ] Impact section quantifies error budget consumed
- [ ] Reviewers have signed off
- [ ] Postmortem is shared with the engineering team (Slack #prod-postmortems)
- [ ] Related runbooks have been updated with findings
