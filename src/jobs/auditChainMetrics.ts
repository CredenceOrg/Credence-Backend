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
 */
export class PrometheusAuditChainMetrics implements AuditChainMetrics {
  incViolation(count = 1): void {
    auditChainIntegrityViolationTotal.inc(count)
  }

  setRowsChecked(count: number): void {
    auditChainVerifierRowsChecked.set(count)
  }

  setLastRunTimestamp(timestamp: number): void {
    auditChainVerifierLastRunTimestamp.set(timestamp / 1000)
  }

  setLastRunValid(valid: boolean): void {
    auditChainVerifierLastRunValid.set(valid ? 1 : 0)
  }
}

export function createPrometheusAuditChainMetrics(): PrometheusAuditChainMetrics {
  return new PrometheusAuditChainMetrics()
}
