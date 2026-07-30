# Runbook: Outbox Queue Lag / Backlog

This runbook covers the outbox event queue falling behind its lag SLO — the
`OutboxPublisherLagHigh` alert and the `outboxPublisher` dependency reporting
`down` on `/api/health`. It complements the general [On-Call Runbook](RUNBOOK.md)
with queue-specific diagnosis and remediation steps.

**Audience:** Operators and on-call engineers
**Last updated:** 2026-07-25

---

## Background

Outbound events (webhooks, downstream integrations) are written to the
`event_outbox` table and published asynchronously by `OutboxPublisher`
(`src/jobs/outbox.ts`), which polls on `OUTBOX_POLL_INTERVAL_MS` (default
`1000`ms) and publishes in batches of `OUTBOX_BATCH_SIZE` (default `100`).

Queue lag is defined as the age of the oldest `pending`/`processing` row in
`event_outbox`:

```sql
SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))
FROM event_outbox
WHERE status IN ('pending', 'processing')
```

(`OutboxRepository.getOldestPendingEventLagSeconds`, used by
`evaluateOutboxPublisherLag` in
[`src/services/health/outbox.ts`](../src/services/health/outbox.ts)).

- **SLO:** lag must stay under `OUTBOX_MAX_LAG_SECONDS` (default **60s**, see
  [`src/config/constants.ts`](../src/config/constants.ts)).
- **Health impact:** once lag exceeds the threshold, `/api/health` reports
  `dependencies.outboxPublisher.status: "down"`, which fails readiness.
- **Alert:** `OutboxPublisherLagHigh` (SEV2, ticket) — see the
  [Quick Reference table](RUNBOOK.md#quick-reference) in the main runbook.

---

## Step 1: Confirm the backlog

```bash
# Readiness check — look at dependencies.outboxPublisher
curl -s http://localhost:3000/api/health | jq .dependencies.outboxPublisher

# Expected when healthy:
# { "status": "up", "lastHeartbeat": "1s ago" }

# Current pending count and oldest event age
psql "$DATABASE_URL" -c "
  SELECT count(*) AS pending,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) AS oldest_age_seconds
  FROM event_outbox
  WHERE status IN ('pending', 'processing');
"

# Prometheus gauge/counters (see src/observability/outboxMetrics.ts)
curl -s http://localhost:3000/metrics | grep -E "outbox_(pending_gauge|published_total|failed_total|dead_letter_total|quarantine_total)"
```

**Interpretation:**

- `pending` count growing steadily and `oldest_age_seconds` above ~60s confirms
  a real backlog, not a single slow event.
- If `outbox_failed_total` or `outbox_dead_letter_total` are climbing alongside
  `pending`, the publisher is running but failing — go to
  [Step 3: Publishing failures](#step-3-publishing-failures).
- If `pending` is high but failure counters are flat, the publisher likely
  isn't running at all — go to [Step 2: Publisher not running](#step-2-publisher-not-running).

---

## Step 2: Publisher not running

**Check leadership, if leader election is enabled**

The outbox loop only runs on the leader when `OUTBOX_LEADER_LEASE_ENABLED=true`
(Postgres advisory lock, see [docs/outbox-scaling.md](outbox-scaling.md#worker-leadership-lease-advisory-locks)).

```bash
# Leadership churn — frequent acquire/lose cycles indicate a flapping
# connection or an instance restarting under load
curl -s http://localhost:3000/metrics | grep -E "outbox_leader_(acquired|lost)_total"

# Confirm which pod currently holds advisory lock 5381
psql "$DATABASE_URL" -c "
  SELECT pid, granted FROM pg_locks
  WHERE locktype = 'advisory' AND objid = 5381;
"
```

- No instance holds the lock → all instances crashed or none has
  `OUTBOX_LEADER_LEASE_ENABLED=true` pointed at the same database. Check pod
  logs for the leader process.
- Lock held but no publishing activity → the leader process is alive but
  stuck; check logs for the pod holding the lock, then restart it
  (`kubectl rollout restart` or `docker compose restart backend`).

**Check process-level health**

```bash
kubectl logs -f deployment/credence-backend -c backend --tail=200 | grep -i outbox
```

Look for repeated `[Outbox]` errors, unhandled promise rejections, or the
absence of any `[Outbox]` log lines at all (implies the poll loop never
started — check `OUTBOX_ENABLED=true` is set).

---

## Step 3: Publishing failures

If events are being picked up but not completing, failures accumulate as
`outbox_failed_total` and eventually move rows to dead-letter
(`outbox_dead_letter_total`) or quarantine (`outbox_quarantine_total`).

```bash
docker compose logs backend --tail=1000 | grep -iE "outbox.*(error|fail|timeout)"
```

- **Downstream/webhook target down or slow** → failures cluster around one
  `aggregate_type`/subscriber. Check the target service; see
  [Timeouts and Retries](timeouts-and-retries.md) for `TIMEOUT_HTTP_MS`
  tuning.
- **Poison-pill payloads** (malformed JSON, schema mismatch, oversized
  payload, unknown event type) are quarantined automatically rather than
  retried — see [Outbox Quarantine](outbox-quarantine.md) for inspecting
  (`GET /v1/admin/outbox/quarantine`) and reinjecting
  (`POST /v1/admin/outbox/quarantine/:id/reinject`) affected rows.
- **Bounded retries exhausted** → check `event_outbox.retry_count` against
  the configured max; rows that exhaust retries stop consuming publisher
  capacity but still count toward lag until resolved.

---

## Step 4: Relieve the backlog

Once the root cause (Step 2 or 3) is fixed, the backlog should drain on its
own within a few poll cycles. To speed recovery under sustained high volume:

1. **Increase batch size / poll frequency temporarily**
   ```bash
   OUTBOX_BATCH_SIZE=250        # default 100
   OUTBOX_POLL_INTERVAL_MS=500  # default 1000
   ```
   Revert once lag is back under the SLO — larger batches increase lock hold
   time per cycle.

2. **Scale out publishers with sharding** (no contention, safe to do live) —
   see [Outbox Publisher Horizontal Scaling](outbox-scaling.md) for the
   `shardCount`/`shardId` configuration and failure-recovery behavior.

3. **Confirm drain**
   ```bash
   watch -n 5 'psql "$DATABASE_URL" -c "SELECT count(*), EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) FROM event_outbox WHERE status IN ('"'"'pending'"'"', '"'"'processing'"'"');"'
   ```
   Both the pending count and oldest-event age should trend down each
   iteration.

---

## Escalation

- **Backlog growing with no clear cause after Steps 1–3** → escalate to the
  backend engineer on call (see [Alert Routing](alert-routing.md)).
- **Sustained quarantine growth for `malformed_json` or `unknown_event_type`**
  → likely a producer or migration defect; escalate to engineering rather
  than reinjecting repeatedly.

---

## Related Documentation

- [On-Call Runbook](RUNBOOK.md) — general alert quick reference and escalation path
- [Outbox Quarantine](outbox-quarantine.md) — poison-pill handling and reinjection
- [Outbox Publisher Horizontal Scaling](outbox-scaling.md) — sharding and leader election
- [Timeouts and Retries](timeouts-and-retries.md) — downstream timeout tuning
- [SLOs](SLO.md) — error budget and burn-rate methodology this runbook's threshold follows
