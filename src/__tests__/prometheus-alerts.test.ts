import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import YAML from 'yaml'

describe('Prometheus Alerts Configuration', () => {
  const alertsPath = join(__dirname, '../../monitoring/prometheus/alerts.yml')
  const alertsContent = readFileSync(alertsPath, 'utf-8')
  const alertsConfig = YAML.parse(alertsContent)

  describe('Error Budget Burn Rate Alert', () => {
    const burnRateAlert = alertsConfig.groups[0].rules.find(
      (rule: any) => rule.alert === 'ErrorBudgetBurnRateHigh'
    )

    it('should have ErrorBudgetBurnRateHigh alert defined', () => {
      expect(burnRateAlert).toBeDefined()
    })

    it('should have burn rate threshold of 2', () => {
      const expr = burnRateAlert.expr
      expect(expr).toContain('> 2')
    })

    it('should calculate burn rate correctly', () => {
      const expr = burnRateAlert.expr
      // The expression should divide by 0.001 (the allowed error rate)
      expect(expr).toContain('/ 0.001')
    })

    it('should use 1h time window for burn rate calculation', () => {
      const expr = burnRateAlert.expr
      expect(expr).toContain('[1h]')
    })

    it('should have critical severity', () => {
      expect(burnRateAlert.labels.severity).toBe('critical')
    })

    it('should have 2 minute for duration', () => {
      expect(burnRateAlert.for).toBe('2m')
    })

    it('should have descriptive summary', () => {
      expect(burnRateAlert.annotations.summary).toBe('High Error Budget Burn Rate')
    })

    it('should include threshold in description', () => {
      expect(burnRateAlert.annotations.description).toContain('threshold: 2x')
    })
  })

  describe('Success Rate SLO Violation Alert', () => {
    const successRateAlert = alertsConfig.groups[0].rules.find(
      (rule: any) => rule.alert === 'SuccessRateSLOViolation'
    )

    it('should have SuccessRateSLOViolation alert defined', () => {
      expect(successRateAlert).toBeDefined()
    })

    it('should have 0.1% error rate threshold', () => {
      const expr = successRateAlert.expr
      expect(expr).toContain('> 0.001')
    })

    it('should have critical severity', () => {
      expect(successRateAlert.labels.severity).toBe('critical')
    })

    it('should reference SLO in description', () => {
      expect(successRateAlert.annotations.description).toContain('SLO: 99.9%')
    })
  })

  describe('Latency SLO Alerts', () => {
    const latencyAlert = alertsConfig.groups[0].rules.find(
      (rule: any) => rule.alert === 'EndpointLatencySLOViolation'
    )

    it('should have EndpointLatencySLOViolation alert defined', () => {
      expect(latencyAlert).toBeDefined()
    })

    it('should have 95% threshold for 250ms latency', () => {
      const expr = latencyAlert.expr
      expect(expr).toContain('< 0.95')
      expect(expr).toContain('le="0.25"')
    })

    it('should have warning severity', () => {
      expect(latencyAlert.labels.severity).toBe('warning')
    })

    it('should group by route', () => {
      const expr = latencyAlert.expr
      expect(expr).toContain('by (route)')
    })
  })

  describe('Alert Configuration Structure', () => {
    it('should have credence_backend_alerts group', () => {
      expect(alertsConfig.groups[0].name).toBe('credence_backend_alerts')
    })

    it('should have 30s evaluation interval', () => {
      expect(alertsConfig.groups[0].interval).toBe('30s')
    })

    it('should have all required alerts defined', () => {
      const ruleNames = alertsConfig.groups[0].rules.map((rule: any) => rule.alert)
      const requiredAlerts = [
        'SuccessRateSLOViolation',
        'ErrorBudgetBurnRateHigh',
        'EndpointLatencySLOViolation',
        'HighP99Latency',
        'HighLatency',
        'DatabaseDown',
        'RedisDown',
        'SlowHealthCheck',
        'LowVerificationRate',
        'HighBulkVerificationFailureRate',
        'PgPoolSaturation',
        'PgWorkerPoolSaturation'
      ]
      
      requiredAlerts.forEach(alert => {
        expect(ruleNames).toContain(alert)
      })
    })
  })
})
