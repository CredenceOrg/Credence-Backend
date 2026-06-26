# Alert Routing Matrix - On-Call Rotation Guide

## Overview

This document describes the severity-aware alert routing matrix used in Credence's monitoring infrastructure. Alerts are routed based on severity level (SEV1/SEV2/SEV3), service, and environment to ensure appropriate on-call escalation and ticket creation.

## Severity Levels

### SEV1 (Critical) - Page Immediately

**Response Time:** <5 minutes  
**Action:** Wake on-call engineer immediately (PagerDuty)  
**Resolution:** Focus all available resources

**Examples:**

- Trust score 5xx error rate violations
- Settlement drift/reconciliation failures
- Database outages
- Cache layer (Redis) unavailable
- Error budget burn rate exceeding 14.4x threshold

**On-Call Team:** Determined by service label (see Routing Matrix)

### SEV2 (High Priority) - Create Ticket

**Response Time:** <30 minutes  
**Action:** Create urgent ticket in Jira/GitHub Issues  
**Resolution:** Prioritize in current sprint

**Examples:**

- Latency SLO violations (p99 > 1s)
- Verification rate drops
- Bulk verification failure rate > 10%
- Connection pool saturation
- Business metrics declining

**On-Call Team:** Slack notification to team channel

### SEV3 (Low Priority) - Ticket Only

**Response Time:** <4 hours  
**Action:** Batch into maintenance window or low-priority queue  
**No paging or urgent notification**

**Examples:**

- Elevated latency (p95 > 1s but p99 < 1s)
- Export queue depth warnings
- Slow health checks
- Worker pool saturation
- Non-critical infrastructure warnings

## Routing Matrix

### Production Environment

| Service          | SEV1                                      | SEV2               | SEV3                    |
| ---------------- | ----------------------------------------- | ------------------ | ----------------------- |
| **trust-score**  | PagerDuty (Platform Team)                 | Slack #prod-alerts | Slack #prod-maintenance |
| **settlement**   | Slack #prod-settlement-oncall + PagerDuty | Slack #prod-alerts | Slack #prod-maintenance |
| **api-platform** | Slack #prod-alerts + PagerDuty            | Slack #prod-alerts | Slack #prod-maintenance |
| **database**     | PagerDuty (Infrastructure Team)           | Slack #prod-alerts | Slack #prod-maintenance |
| **cache**        | PagerDuty (Infrastructure Team)           | Slack #prod-alerts | Slack #prod-maintenance |
| **verification** | Slack #prod-alerts                        | Slack #prod-alerts | Slack #prod-maintenance |

**Routing Rules:**

- **Group Wait:** 5s for SEV1 (immediate escalation), 2min for SEV2, 5min for SEV3
- **Repeat Interval:** 30min for SEV1, 2h for SEV2, 6-8h for SEV3
- **Inhibition:** SEV1 suppresses SEV2/SEV3 for same service to reduce alert noise during outages

### Staging Environment

| Service          | SEV1                  | SEV2                  | SEV3                       |
| ---------------- | --------------------- | --------------------- | -------------------------- |
| **All Services** | Slack #staging-alerts | Slack #staging-alerts | Slack #staging-maintenance |

**Routing Rules:**

- All alerts route to Slack (no PagerDuty)
- SEV1: Group wait 1min (for visibility)
- SEV2: Group wait 3min
- SEV3: Group wait 10min

### Development/Test Environment

| Service          | All Severities    |
| ---------------- | ----------------- |
| **All Services** | Slack #dev-alerts |

**Routing Rules:**

- Batched with 5min group wait
- Low repeat interval (no page urgency)

## On-Call Rotation Expectations

### Team Assignments

**Platform Team** (trust-score, api-platform, verification, general)

- Responsible for application-level alerts
- Runbooks: Performance, database connections, verification service
- On-call rotation: Weekly (Monday-Monday)
- Escalation: Lead → Manager (after 15 minutes)

**Infrastructure Team** (database, cache, networking)

- Responsible for infrastructure-level alerts
- Runbooks: Database recovery, Redis failover, network troubleshooting
- On-call rotation: Weekly (Monday-Monday)
- Escalation: Lead → Manager (after 15 minutes)

**Finance Team** (settlement, reconciliation)

- Responsible for financial transaction alerts
- Runbooks: Settlement drift resolution, transaction verification
- On-call rotation: Daily (preferred) or Weekly
- Escalation: Lead → Finance Director (after 15 minutes)

### On-Call Responsibilities

1. **Alert Acknowledgment** (< 2 minutes for SEV1)
   - Acknowledge PagerDuty alert immediately
   - Acknowledge in Slack channel

2. **Initial Investigation** (< 5 minutes for SEV1)
   - Check alert runbook
   - Review recent deployments
   - Check infrastructure status page
   - Review logs and metrics dashboard

3. **Mitigation** (target < 15 minutes for SEV1)
   - Execute runbook procedures
   - Escalate to on-call manager if stuck
   - Keep team updated in Slack

4. **Resolution** (target < 1 hour for SEV1)
   - Full incident investigation
   - Document root cause
   - Create follow-up ticket for permanent fix
   - Post-mortem for customer-facing incidents

### Alert Fatigue Management

**Inhibition Rules** suppress lower-severity alerts when higher-severity alerts fire:

- SEV1 firing → SEV2 and SEV3 alerts for same service are suppressed
- SEV2 firing → SEV3 alerts for same service are suppressed

This prevents alert storms during outages.

**Flapping Alert Protection:**

- Maintenance window alerts suppress SEV1/SEV2 during planned downtime
- Use `-for:` clause (currently 1-5 minutes per alert) to reduce flapping
- Alerts must be firing consistently before triggering

## Receivers Configuration

### Environment Variables Required

```bash
# Slack Integration
ALERTMANAGER_SLACK_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# PagerDuty Integration
ALERTMANAGER_PAGERDUTY_SERVICE_KEY_PROD=your-service-key-production
ALERTMANAGER_PAGERDUTY_KEY=your-integration-key

# Slack Channels (optional, defaults shown in config)
# #prod-alerts - Production SEV1/SEV2
# #prod-settlement-oncall - Settlement emergencies
# #prod-maintenance - Production SEV3/maintenance
# #staging-alerts - Staging all severities
# #dev-alerts - Development environment
```

**Security Note:** All credentials must be provided via environment variables, never committed to the repository.

### Adding New Receivers

1. Add environment variable in deployment config
2. Update alertmanager.yml with new receiver section
3. Add route matcher in routes section
4. Test with `amtool` (see Testing section)
5. Deploy and verify routing via Slack test messages

## Testing & Validation

### Configuration Validation

```bash
# Validate alertmanager.yml syntax
amtool check-config monitoring/prometheus/alertmanager.yml

# Validate alert rules syntax
promtool check rules monitoring/prometheus/alerts.yml

# Validate alert expression (requires Prometheus running)
promtool check rules monitoring/prometheus/alerts.yml --lint=all
```

### Manual Testing

**Slack Routing Test:**

```bash
# Send test alert
curl -X POST http://localhost:9093/api/v1/alerts \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {
      "alertname": "TestAlert",
      "severity": "SEV1",
      "service": "test",
      "environment": "prod"
    },
    "annotations": {
      "summary": "Test alert routing",
      "description": "This is a test"
    }
  }]'
```

**PagerDuty Integration Test:**

- Access PagerDuty console
- Create test incident
- Verify on-call engineer receives notification
- Test acknowledgment flow

### Edge Cases Handled

1. **Alert Flapping**
   - Minimum 1-5 minute `for:` clause prevents rapid fire/clear cycles
   - AlertManager deduplication on AlertManager side

2. **Maintenance Windows**
   - Create `MaintenanceWindow` alert during planned downtime
   - Inhibition rules suppress page-worthy alerts automatically
   - Set `MaintenanceWindow` alert with environment label to match context

3. **Dependency Outages**
   - External API failures don't trigger cascading alerts
   - Alert for failed health checks, not service errors
   - Inhibition rules prevent noise from cascading failures

4. **Duplicate Alerts**
   - AlertManager groups identical alerts by service/environment
   - Configuration uses `group_by` to batch related alerts
   - Reduces notification spam to single summary per group

5. **Alert Storms**
   - Inhibition rules active (see above)
   - Group wait delays (5s-10min) batch related alerts
   - Repeat intervals prevent re-notification spam

## Runbook URLs

All alerts include `runbook_url` annotation linking to procedures:

- **Performance:** https://docs.credence.org/runbooks/slo-violations
- **Database:** https://docs.credence.org/runbooks/database
- **Infrastructure:** https://docs.credence.org/runbooks/infrastructure
- **Verification:** https://docs.credence.org/runbooks/verification
- **Settlement:** https://docs.credence.org/runbooks/settlement
- **Monitoring:** https://docs.credence.org/runbooks/monitoring

### Runbook Best Practices

1. Start with quick diagnostics (check logs, dashboards)
2. Include common issues and their resolution
3. When to escalate vs. auto-remediate
4. Links to relevant Grafana dashboards
5. Service dependency map (what else might be affected)

## Monitoring the Monitor

Monitor these meta-metrics to ensure alert routing is working:

```promql
# Alert evaluation latency
prometheus_rule_evaluation_duration_seconds

# Alertmanager notification failures
alertmanager_notifications_failed_total

# Notifications sent by severity/receiver
alertmanager_notifications_total{receiver="..."}
```

## Glossary

| Term                | Definition                                                  |
| ------------------- | ----------------------------------------------------------- |
| **SEV1**            | Critical - immediate page, resolve within 1 hour            |
| **SEV2**            | High Priority - create ticket, resolve within 4 hours       |
| **SEV3**            | Low Priority - batch into maintenance, resolve within 1 day |
| **Runbook**         | Step-by-step incident response procedure                    |
| **Inhibition**      | Suppressing lower-priority alerts during major incidents    |
| **Group Wait**      | Delay before sending alert group (allows batching)          |
| **Repeat Interval** | How often to re-notify for ongoing alert                    |
| **Flapping**        | Alert rapidly firing and clearing repeatedly                |

## Related Documentation

- [docs/sla-metrics.md](./sla-metrics.md) - SLO targets and metrics
- [docs/monitoring.md](./monitoring.md) - Prometheus/Grafana setup
- [docs/observability.md](./observability.md) - Logging and tracing
- [monitoring/README.md](../monitoring/README.md) - Local setup guide
