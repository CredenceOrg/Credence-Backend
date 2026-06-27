# Service Level Objectives (SLOs)

## Overview

This document defines the Service Level Objectives (SLOs) for the Credence Backend API. SLOs are measurable targets for service reliability that guide engineering decisions and alerting thresholds.

## SLO Definitions

### Success Rate SLO

**Target:** 99.9% success rate (0.1% error budget)

**Definition:** Percentage of HTTP requests that complete successfully (HTTP status codes 2xx and 3xx).

**Measurement Window:** Rolling 30 days

**Error Budget Calculation:**
```
Error Budget = 1 - Success Rate Target
Error Budget = 1 - 0.999 = 0.001 (0.1%)
```

**Alerting:**
- **Success Rate SLO Violation:** Triggers when error rate exceeds 0.1% for 2 minutes
- **Error Budget Burn Rate:** Triggers when burn rate > 2 for 2 minutes

### Latency SLO

**Target:** 95% of successful requests complete within 250ms

**Definition:** Percentile latency for successful HTTP requests (status codes 2xx and 3xx).

**Measurement Window:** Rolling 30 days

**Alerting:**
- **Endpoint Latency SLO Violation:** Triggers when < 95% of successful requests on an endpoint complete within 250ms for 5 minutes
- **High p99 Latency:** Triggers when p99 latency exceeds 1s for 5 minutes

## Error Budget and Burn Rate

### Error Budget

The error budget represents the allowable amount of errors within the SLO period. For a 99.9% success rate SLO over 30 days:

```
Total Requests = R
Allowed Errors = R × 0.001
```

### Burn Rate

Burn rate measures how quickly the error budget is being consumed relative to the expected rate.

**Formula:**
```
Burn Rate = (Current Error Rate) / (Allowed Error Rate)
```

**Burn Rate Thresholds:**
- **Burn Rate < 1:** Consuming error budget slower than expected (healthy)
- **Burn Rate = 1:** Consuming error budget at expected rate (on track)
- **Burn Rate > 1:** Consuming error budget faster than expected (concerning)
- **Burn Rate > 2:** Consuming error budget more than 2x faster than expected (critical)

**Alerting Threshold:** Burn rate > 2 for 2 minutes

**Rationale:** A burn rate > 2 means the error budget will be exhausted in less than half the SLO period if the current error rate continues. This provides early warning to prevent SLO breaches.

### Burn Rate Calculation Example

Given:
- SLO: 99.9% success rate (0.1% error budget)
- Current error rate: 0.3% (measured over 1 hour)

```
Burn Rate = 0.003 / 0.001 = 3
```

With a burn rate of 3, the error budget would be exhausted in 10 days (30 days / 3) if the error rate continues.

## Metrics

### Success Rate Metrics

**Metric:** `http_requests_status_total` (Counter)

**Labels:**
- `status_class`: HTTP status class (1xx, 2xx, 3xx, 4xx, 5xx)
- `route`: Normalized route template (e.g., `/api/trust/:address`)
- `method`: HTTP method

**PromQL Queries:**

Current error rate (5xx):
```promql
sum(rate(http_requests_status_total{status_class="5xx"}[5m])) 
/ sum(rate(http_requests_status_total[5m]))
```

Burn rate:
```promql
(
  sum(rate(http_requests_status_total{status_class="5xx"}[1h])) 
  / sum(rate(http_requests_status_total[1h]))
) / 0.001
```

### Latency Metrics

**Metric:** `http_request_duration_seconds` (Histogram)

**Labels:**
- `route`: Normalized route template
- `method`: HTTP method
- `status_class`: HTTP status class

**Buckets:** `0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 2.5, 5, 7.5, 10`

**PromQL Queries:**

Percentage of requests under 250ms:
```promql
sum(rate(http_request_duration_seconds_bucket{le="0.25", status_class="2xx"}[5m])) by (route)
/ sum(rate(http_request_duration_seconds_count{status_class="2xx"}[5m])) by (route)
```

p99 latency:
```promql
histogram_quantile(0.99, 
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route)
)
```

## Alerting Rules

### Critical Alerts

**Success Rate SLO Violation**
- **Condition:** Error rate > 0.1% for 2 minutes
- **Severity:** Critical
- **Action:** Immediate investigation, potential rollback

**Error Budget Burn Rate High**
- **Condition:** Burn rate > 2 for 2 minutes
- **Severity:** Critical
- **Action:** Investigate error spike, prepare mitigation

**Database Down**
- **Condition:** Database health check fails for 1 minute
- **Severity:** Critical
- **Action:** Immediate infrastructure response

**Redis Down**
- **Condition:** Redis health check fails for 1 minute
- **Severity:** Critical
- **Action:** Immediate infrastructure response

### Warning Alerts

**Endpoint Latency SLO Violation**
- **Condition:** < 95% of requests under 250ms for 5 minutes
- **Severity:** Warning
- **Action:** Investigate performance degradation

**High p99 Latency**
- **Condition:** p99 latency > 1s for 5 minutes
- **Severity:** Warning
- **Action:** Investigate slow endpoints

**High Latency**
- **Condition:** p95 latency > 1s for 5 minutes
- **Severity:** Warning
- **Action:** Performance investigation

**Slow Health Check**
- **Condition:** Health check duration > 3s for 5 minutes
- **Severity:** Warning
- **Action:** Investigate dependency performance

**Low Verification Rate**
- **Condition:** Verification rate < 0.1 req/s for 30 minutes
- **Severity:** Warning
- **Action:** Business metric investigation

**High Bulk Verification Failure Rate**
- **Condition:** Bulk verification failure rate > 10% for 5 minutes
- **Severity:** Warning
- **Action:** Investigate bulk processing issues

**PostgreSQL Connection Pool Saturation**
- **Condition:** Requests waiting for connection > 0 for 2 minutes
- **Severity:** Warning
- **Action:** Consider increasing pool size or optimizing queries

**Worker Connection Pool Saturation**
- **Condition:** Worker jobs waiting for connection > 0 for 5 minutes
- **Severity:** Warning
- **Action:** Consider increasing worker pool size

## SLO Compliance Reporting

### Monthly SLO Report

At the end of each SLO period (30 days), generate an SLO compliance report including:

1. **Success Rate Compliance**
   - Overall success rate
   - Error budget consumed
   - Number and duration of SLO violations

2. **Latency Compliance**
   - Percentage of endpoints meeting latency SLO
   - p50, p95, p99 latency percentiles
   - Number and duration of latency violations

3. **Incident Analysis**
   - Incidents that impacted SLO
   - Root causes
   - Preventive measures taken

4. **Trend Analysis**
   - Month-over-month comparison
   - Emerging patterns or concerns

### SLO Dashboard

The Grafana dashboard (`monitoring/grafana/dashboard.json`) provides real-time SLO monitoring including:

- Current error rate and burn rate
- Latency percentiles by endpoint
- SLO compliance status
- Error budget remaining

## Incident Response

### SLO Breach Procedure

When an SLO breach occurs:

1. **Immediate Response (0-15 minutes)**
   - Acknowledge alert
   - Assess impact scope
   - Initiate mitigation (rollback, scale up, etc.)

2. **Investigation (15-60 minutes)**
   - Identify root cause
   - Document timeline
   - Implement temporary fix if needed

3. **Resolution (1-24 hours)**
   - Implement permanent fix
   - Verify SLO recovery
   - Update runbooks

4. **Post-Incident (24-72 hours)**
   - Conduct post-mortem
   - Update documentation
   - Implement preventive measures

### Error Budget Policy

The error budget is a shared resource. When the error budget is exhausted:

- **Feature deploys:** Paused until error budget recovers to > 50%
- **Non-critical changes:** Deferred until error budget recovers to > 75%
- **Critical fixes:** Allowed immediately with approval

## Configuration

### SLO Constants

SLO targets are defined in the Prometheus alerting configuration (`monitoring/prometheus/alerts.yml`):

- **Success Rate Target:** 99.9% (0.001 error rate)
- **Latency Target:** 250ms at 95th percentile
- **Burn Rate Alert Threshold:** 2

### Environment-Specific Adjustments

SLO targets may be adjusted per environment:

- **Production:** 99.9% success rate, 250ms latency
- **Staging:** 99.5% success rate, 500ms latency
- **Development:** No SLO enforced

## References

- [Google SRE Workbook - SLOs](https://sre.google/workbook/service-level-objectives/)
- [Prometheus Alerting Best Practices](https://prometheus.io/docs/practices/alerting/)
- [Site Reliability Engineering](https://sre.google/sre-book/table-of-contents/)
- [Monitoring Documentation](./monitoring.md)
- [SLA Metrics Documentation](./sla-metrics.md)
