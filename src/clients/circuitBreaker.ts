import { SorobanClientError } from './soroban.js'
import client from 'prom-client'
import {
  CIRCUIT_BREAKER_DEFAULTS,
  CIRCUIT_BREAKER_OPEN_WINDOW_MS,
  CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
} from '../config/sorobanConstants.js'

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerConfig {
  failureThreshold: number
  openWindowMs?: number
  halfOpenAfterMs?: number
  /** @deprecated */
  cooldownPeriodMs?: number
}

export const sorobanCircuitStateGauge = new client.Gauge({
  name: 'soroban_circuit_state',
  help: 'Soroban circuit breaker state (0 = CLOSED, 1 = OPEN, 2 = HALF_OPEN)',
  labelNames: ['host'],
})

export function registerCircuitBreakerMetrics(registry: client.Registry): void {
  if (!registry.getSingleMetric('soroban_circuit_state')) {
    registry.registerMetric(sorobanCircuitStateGauge)
  }
}

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED'
  private failureCount = 0
  private openedAt = 0
  private activeProbes = 0

  private readonly failureThreshold: number
  private readonly openWindowMs: number
  private readonly halfOpenAfterMs: number

  constructor(
    public readonly host: string,
    config: CircuitBreakerConfig,
  ) {
    this.failureThreshold = config.failureThreshold

    const resolvedHalfOpen =
      config.halfOpenAfterMs ??
      config.cooldownPeriodMs ??
      CIRCUIT_BREAKER_DEFAULTS.halfOpenAfterMs

    this.openWindowMs = config.openWindowMs ?? CIRCUIT_BREAKER_DEFAULTS.openWindowMs
    this.halfOpenAfterMs = Math.max(resolvedHalfOpen, this.openWindowMs)

    this.updateMetrics()
  }

  public getState(): BreakerState {
    this.checkTimers()
    return this.state
  }

  public getFailureCount(): number {
    return this.failureCount
  }

  private checkTimers(): void {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt
      if (elapsed >= this.halfOpenAfterMs) {
        this.transitionTo('HALF_OPEN')
      }
    }
  }

  public isOpenWindowExpired(): boolean {
    if (this.state !== 'OPEN') return false
    return Date.now() - this.openedAt >= this.openWindowMs
  }

  public transitionTo(newState: BreakerState): void {
    this.state = newState
    if (newState === 'OPEN') {
      this.openedAt = Date.now()
      this.activeProbes = 0
    } else if (newState === 'CLOSED') {
      this.failureCount = 0
      this.activeProbes = 0
    } else if (newState === 'HALF_OPEN') {
      this.activeProbes = 0
    }
    this.updateMetrics()
  }

  private updateMetrics(): void {
    let val = 0
    if (this.state === 'OPEN') val = 1
    else if (this.state === 'HALF_OPEN') val = 2

    try {
      sorobanCircuitStateGauge.set({ host: this.host }, val)
    } catch {
      // Ignore Prometheus errors in test environments where the registry is reset
    }
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkTimers()

    if (this.state === 'OPEN') {
      throw new SorobanClientError({
        code: 'NETWORK_ERROR',
        message: `Soroban circuit breaker is OPEN for host: ${this.host}`,
      })
    }

    if (this.state === 'HALF_OPEN') {
      if (this.activeProbes >= 1) {
        throw new SorobanClientError({
          code: 'NETWORK_ERROR',
          message: `Soroban circuit breaker is HALF_OPEN for host: ${this.host} and a probe is already in progress`,
        })
      }
      this.activeProbes += 1
    }

    try {
      const result = await fn()

      if (this.state === 'HALF_OPEN') {
        this.transitionTo('CLOSED')
      } else if (this.state === 'CLOSED') {
        this.failureCount = 0
      }
      return result
    } catch (error) {
      this.recordFailure()
      throw error
    }
  }

  private recordFailure(): void {
    if (this.state === 'CLOSED') {
      this.failureCount += 1
      if (this.failureCount >= this.failureThreshold) {
        this.transitionTo('OPEN')
      }
    } else if (this.state === 'HALF_OPEN') {
      this.transitionTo('OPEN')
    }
  }
}

const breakers = new Map<string, CircuitBreaker>()

export function getCircuitBreaker(host: string, config: CircuitBreakerConfig): CircuitBreaker {
  let breaker = breakers.get(host)
  if (!breaker) {
    breaker = new CircuitBreaker(host, config)
    breakers.set(host, breaker)
  }
  return breaker
}

export function resetCircuitBreakers(): void {
  breakers.clear()
}
