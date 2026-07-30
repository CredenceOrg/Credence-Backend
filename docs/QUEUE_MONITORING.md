# Queue Monitoring & On-Call Guide

**Audience**: Operators (SREs, Platform Engineers, and On-Call Responders)

This guide explains how queue-related alerts fire in the Credence Backend, what they mean, and how operators should respond. The Credence Backend utilizes PostgreSQL connection pools and background workers for handling queued jobs. 

For a high-level overview of observability, please see the [Monitoring Overview](monitoring.md).

---

## 1. PostgreSQL API Pool Saturation (`PgPoolSaturation`)

**Severity:** SEV2 (Resource Exhaustion)
**Routing:** `#prod-alerts` (Slack) / Staging Tickets

### Why it fires
This alert triggers when the API connection pool is saturated and incoming HTTP requests are queued waiting for a database connection for more than 2 minutes.

**Prometheus Query:**
```promql
pg_pool_waiting_count{job="credence-backend", pool="api"} > 0
```

### Concrete Example (Slack Alert)
> ⚠️ **Production Alert - SEV2**
> **Alert:** PgPoolSaturation
> **Service:** database
> **Summary:** PostgreSQL connection pool saturated
> **Description:** API pool has 14 requests queued waiting for a connection for >2 minutes. Consider increasing DB_POOL_MAX or investigating slow queries.

### What to do
1. **Identify slow queries:** Check the Grafana dashboard for API endpoints with high p99 latency (`HighP99Latency` alert may also fire).
2. **Check database locks:** A long-running transaction may be blocking others. Query `pg_locks` or review recent slow query logs.
3. **Scale connection pools (Mitigation):** If the database has adequate CPU/Memory, increase `DB_POOL_MAX` in the `.env` configuration and restart the application pods.

---

## 2. PostgreSQL Worker Pool Saturation (`PgWorkerPoolSaturation`)

**Severity:** SEV3 (Low Priority Ticket)
**Routing:** `#prod-low-priority` (Slack) / Staging Tickets

### Why it fires
Background workers process queued jobs like bulk verifications. This alert fires when the worker pool exhausts its connections, causing background tasks to wait for a connection for more than 5 minutes.

**Prometheus Query:**
```promql
pg_pool_waiting_count{job="credence-backend", pool="worker"} > 0
```

### Concrete Example (Slack Alert)
> 📌 **SEV3 - PgWorkerPoolSaturation**
> **Service:** database
> **Summary:** Worker connection pool saturated
> **Description:** Worker pool has 5 jobs queued waiting for a connection for >5 minutes.

### What to do
1. **Review worker job types:** Identify if a specific background task (e.g., bulk identity verification) is stalled.
2. **Review application logs:** Check for repetitive timeouts or retries from the worker processes.
3. **Scale worker pods:** If CPU/RAM allows, scale up the worker deployments in Kubernetes to distribute the job queue over more nodes.

---

## 3. Export Queue Depth (`ExportQueueDepth`)

**Severity:** SEV3
**Routing:** `#prod-maintenance` (Slack, Ticket only, No Page)

### Why it fires
This alert monitors the depth of asynchronous data exports. It fires when the number of queued export tasks grows too large, indicating that the workers processing the export queue are falling behind the enqueue rate.

### Concrete Example (Slack Alert)
> 📌 **SEV3 - ExportQueueDepth**
> **Service:** data-export
> **Description:** Export queue depth is currently 1500 tasks, exceeding the threshold. Processing latency may increase.

### What to do
1. **Check consumer health:** Verify that export worker pods are healthy and not repeatedly crashing (OOMKilled).
2. **Purge poison pills:** Sometimes a specific export job crashes the worker. Check the dead-letter queue and quarantine malformed tasks. 

---

## Cross References
- [Main README](../README.md)
- [Monitoring Setup and Observability](monitoring.md)
- [Runbooks](RUNBOOK.md)
