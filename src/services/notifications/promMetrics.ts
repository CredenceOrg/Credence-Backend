import * as promClient from 'prom-client'

type CounterMetric = {
  inc(labels?: Record<string, string | number>, value?: number): void
}

function getCounterMetric(
  name: string,
  help: string,
  labelNames: string[] = []
): CounterMetric | null {
  try {
    const existing = promClient.register.getSingleMetric(name)
    if (existing) {
      return existing as CounterMetric
    }

    return new promClient.Counter({
      name,
      help,
      labelNames,
      registers: [promClient.register],
    }) as CounterMetric
  } catch {
    return null
  }
}

let providerAttemptsMetric: CounterMetric | null | undefined
let providerSuccessMetric: CounterMetric | null | undefined
let failoverMetric: CounterMetric | null | undefined
let dlqMetric: CounterMetric | null | undefined

export function recordNotificationProviderAttempt(provider: string, outcome: string): void {
  if (providerAttemptsMetric === undefined) {
    providerAttemptsMetric = getCounterMetric(
      'notification_provider_attempts_total',
      'Total notification delivery attempts by provider and outcome',
      ['provider', 'outcome']
    )
  }

  providerAttemptsMetric?.inc({ provider, outcome }, 1)
}

export function recordNotificationProviderSuccess(provider: string): void {
  if (providerSuccessMetric === undefined) {
    providerSuccessMetric = getCounterMetric(
      'notification_provider_success_total',
      'Total successful notification deliveries by provider',
      ['provider']
    )
  }

  providerSuccessMetric?.inc({ provider }, 1)
}

export function recordNotificationFailover(fromProvider: string, toProvider: string): void {
  if (failoverMetric === undefined) {
    failoverMetric = getCounterMetric(
      'notification_failovers_total',
      'Total notification delivery failovers between providers',
      ['from_provider', 'to_provider']
    )
  }

  failoverMetric?.inc({ from_provider: fromProvider, to_provider: toProvider }, 1)
}

export function recordNotificationDlq(reason: string): void {
  if (dlqMetric === undefined) {
    dlqMetric = getCounterMetric(
      'notification_dlq_total',
      'Total notifications routed to the dead-letter queue',
      ['reason']
    )
  }

  dlqMetric?.inc({ reason }, 1)
}

export function _resetNotificationPromMetricsForTests(): void {
  promClient.register.clear()
  providerAttemptsMetric = undefined
  providerSuccessMetric = undefined
  failoverMetric = undefined
  dlqMetric = undefined
}
