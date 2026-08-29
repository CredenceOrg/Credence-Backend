/**
 * Compact, operator-facing metric helpers.
 *
 * Prefer domain-specific modules under `src/observability/` or
 * `src/jobs/` for deep instrumentation. Modules here expose *summary*
 * surfaces that power small Grafana rows / runbook queries.
 */
export * from './webhookLagDashboard.js'
