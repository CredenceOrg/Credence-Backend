import { beforeEach, describe, expect, it } from 'vitest'
import {
  PrometheusAuditChainMetrics,
  auditChainVerifierLastRunValid,
} from './auditChainMetrics.js'
import { register } from '../middleware/metrics.js'

describe('PrometheusAuditChainMetrics', () => {
  beforeEach(() => {
    auditChainVerifierLastRunValid.reset()
  })

  async function readGaugeValue(): Promise<number> {
    const metrics = await register.getMetricsAsJSON()
    const gauge = metrics.find((metric) => metric.name === 'audit_chain_verifier_last_run_valid')
    const value = gauge?.values?.[0]?.value
    return typeof value === 'number' ? value : Number(value ?? NaN)
  }

  it('sets last run valid gauge to 1 on success', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunValid(true)

    expect(await readGaugeValue()).toBe(1)
  })

  it('sets last run valid gauge to 0 on detected break', async () => {
    const metrics = new PrometheusAuditChainMetrics()
    metrics.setLastRunValid(false)

    expect(await readGaugeValue()).toBe(0)
  })
})
