import client from 'prom-client'
import { register } from '../middleware/metrics.js'
import type { AuditChainMetrics } from './auditChainVerifier.js'

export const auditChainIntegrityViolationTotal = new client.Counter({
  name: 'audit_chain_integrity_violation_total',
  help: 'Total number of audit log chain integrity violations detected',
  registers: [register],
})

export const auditChainVerifierRowsChecked = new client.Gauge({
  name: 'audit_chain_verifier_rows_checked',
  help: 'Number of audit log rows checked in the last verification run',
  registers: [register],
})

export const auditChainVerifierLastRunTimestamp = new client.Gauge({
  name: 'audit_chain_verifier_last_run_timestamp',
  help: 'Unix timestamp of the last audit chain verification run',
  registers: [register],
})

export const auditChainVerifierLastRunValid = new client.Gauge({
  name: 'audit_chain_verifier_last_run_valid',
  help: '1 when the last audit chain verification passed, 0 when a break was detected',
  registers: [register],
})

/**
 * Prometheus-backed metrics sink for the audit chain verifier.
 *
 * Invariants:
 * - Counters never decrease; negative or non-finite increments are rejected without
 *   mutating metric state so a bad caller cannot corrupt the exposed series.
 * - Gauges only accept finite numbers. Non-finite inputs are ignored rather than
 *   writing NaN/Infinity into the registry, which would poison downstream alerting.
 * - Timestamps are converted from milliseconds to seconds exactly once and must be
 *   finite and non-negative.
 */
export class PrometheusAuditChainMetrics implements AuditChainMetrics {
  incViolation(count = 1): void {
    if (!Number.isFinite(count) || count < 0) {
      return
    }
    auditChainIntegrityViolationTotal.inc(count)
  }

  setRowsChecked(count: number): void {
    if (!Number.isFinite(count) || count < 0) {
      return
    }
    auditChainVerifierRowsChecked.set(count)
  }

  setLastRunTimestamp(timestamp: number): void {
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      return
    }
    auditChainVerifierLastRunTimestamp.set(timestamp / 1000)
  }

  setLastRunValid(valid: boolean): void {
    auditChainVerifierLastRunValid.set(valid ? 1 : 0)
  }
}

export function createPrometheusAuditChainMetrics(): PrometheusAuditChainMetrics {
  return new PrometheusAuditChainMetrics()
}
