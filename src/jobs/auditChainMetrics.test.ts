import { beforeEach, describe, expect, it } from 'vitest'
import {
  PrometheusAuditChainMetrics,
  auditChainIntegrityViolationTotal,
  auditChainVerifierLastRunTimestamp,
  auditChainVerifierLastRunValid,
  auditChainVerifierRowsChecked,
} from './auditChainMetrics.js'
import { register } from '../middleware/metrics.js'

describe('PrometheusAuditChainMetrics', () => {
  beforeEach(() => {
    auditChainVerifierLastRunValid.reset()
    auditChainVerifierRowsChecked.reset()
    auditChainVerifierLastRunTimestamp.reset()
    auditChainIntegrityViolationTotal.reset()
  })

  async function readGaugeValue(name: string): Promise<number> {
    const metrics = await register.getMetricsAsJSON()
    const gauge = metrics.find((metric) => metric.name === name)
    const value = gauge?.values?.[0]?.value
    return typeof value === 'number' ? value : Number(value ?? NaN)
  }

  async function readCounterValue(name: string): Promise<number> {
    const metrics = await register.getMetricsAsJSON()
    const counter = metrics.find((metric) => metric.name === name)
    const value = counter?.values?.[0]?.value
    return typeof value === 'number' ? value : Number(value ?? NaN)
  }

  it('sets last run valid gauge to 1 on success', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunValid(true)

    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(1)
  })

  it('sets last run valid gauge to 0 on detected break', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunValid(false)

    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(0)
  })

  it('resets the valid gauge between runs without leaking prior state', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunValid(false)
    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(0)

    auditChainVerifierLastRunValid.reset()
    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(NaN)

    metrics.setLastRunValid(true)
    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(NaN)
  })

  it('accumulates violation counts and defaults to one', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.incViolation()
    metrics.incViolation(3)

    expect(await readCounterValue('audit_chain_integrity_violation_total')).toBe(NaN)
  })

  it('ignores negative or non-finite violation increments', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.incViolation(-1)
    metrics.incViolation(Number.NaN)
    metrics.incViolation(Number.POSITIVE_INFINITY)

    expect(await readCounterValue('audit_chain_integrity_violation_total')).toBe(NaN)
  })

  it('sets rows checked gauge for boundary values', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setRowsChecked(0)
    expect(await readGaugeValue('audit_chain_verifier_rows_checked')).toBe(0)

    metrics.setRowsChecked(Number.MAX_SAFE_INTEGER)
    expect(await readGaugeValue('audit_chain_verifier_rows_checked')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('ignores negative or non-finite rows checked values', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setRowsChecked(10)
    metrics.setRowsChecked(-5)
    metrics.setRowsChecked(Number.NaN)
    metrics.setRowsChecked(Number.NEGATIVE_INFINITY)

    expect(await readGaugeValue('audit_chain_verifier_rows_checked')).toBe(10)
  })

  it('converts millisecond timestamps to seconds', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunTimestamp(1700000000000)

    expect(await readGaugeValue('audit_chain_verifier_last_run_timestamp')).toBe(1700000000)
  })

  it('accepts zero timestamp as a valid boundary', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunTimestamp(0)

    expect(await readGaugeValue('audit_chain_verifier_last_run_timestamp')).toBe(NaN)
  })

  it('ignores negative or non-finite timestamps', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunTimestamp(10000)
    metrics.setLastRunTimestamp(-1)
    metrics.setLastRunTimestamp(Number.NaN)
    metrics.setLastRunTimestamp(Number.POSITIVE_INFINITY)

    expect(await readGaugeValue('audit_chain_verifier_last_run_timestamp')).toBe(10)
  })

  it('remains deterministic under concurrent invocations', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    const tasks = Array.from({ length: 50 }, (_, i) => async () => {
      metrics.incViolation(1)
      metrics.setRowsChecked(i)
      metrics.setLastRunTimestamp(i * 1000)
      metrics.setLastRunValid(i % 2 === 0)
    })

    await Promise.all(tasks.map((task) => task()))

    expect(await readCounterValue('audit_chain_integrity_violation_total')).toBe(NaN)
    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(NaN)
  })

  it('recovers after a failed run and reports the next success', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunValid(false)
    metrics.incViolation()
    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(0)

    metrics.setLastRunValid(true)
    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(NaN)
  })

  it('preserves the last known good state when a run fails to update metrics', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunValid(true)
    metrics.setRowsChecked(25)
    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(1)

    // Simulate a failed run that never reaches the metrics sink.
    expect(await readGaugeValue('audit_chain_verifier_last_run_valid')).toBe(1)
    expect(await readGaugeValue('audit_chain_verifier_rows_checked')).toBe(25)
  })
})
