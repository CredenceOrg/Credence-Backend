import { SorobanClientError } from './soroban.js'
import client from 'prom-client'

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerConfig {
  failureThreshold: number
  cooldownPeriodMs: number
}

// Prometheus Gauge for the circuit state per host
// State values: 0 = CLOSED, 1 = OPEN, 2 = HALF_OPEN
export const sorobanCircuitStateGauge = new client.Gauge({
  name: 'soroban_circuit_state',
  help: 'Soroban circuit breaker state (0 = CLOSED, 1 = OPEN, 2 = HALF_OPEN)',
  labelNames: ['host'],
})

export function registerCircuitBreakerMetrics(registry: client.Registry): void {
  // Check if it's already registered to avoid error
  if (!registry.getSingleMetric('soroban_circuit_state')) {
    registry.registerMetric(sorobanCircuitStateGauge)
  }
}

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED'
  private failureCount = 0
  private openedAt = 0
  private activeProbes = 0 // Count active concurrent probes in HALF_OPEN state

  constructor(
    public readonly host: string,
    private readonly config: CircuitBreakerConfig
  ) {
    this.updateMetrics()
  }

  public getState(): BreakerState {
    this.checkCooldown()
    return this.state
  }

  public getFailureCount(): number {
    return this.failureCount
  }

  private checkCooldown(): void {
    if (this.state === 'OPEN') {
      const now = Date.now()
      if (now - this.openedAt >= this.config.cooldownPeriodMs) {
        this.transitionTo('HALF_OPEN')
      }
    }
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
    } catch {}
  }

  /**
   * Executes a Soroban RPC operation within the protection of the circuit breaker.
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkCooldown()

    if (this.state === 'OPEN') {
      throw new SorobanClientError({
        code: 'NETWORK_ERROR',
        message: `Soroban circuit breaker is OPEN for host: ${this.host}`,
      })
    }

    if (this.state === 'HALF_OPEN') {
      if (this.activeProbes >= 1) {
        // Concurrency limit in HALF_OPEN: only allow a single probe request, others fail fast
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
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionTo('OPEN')
      }
    } else if (this.state === 'HALF_OPEN') {
      // Any failure during HALF_OPEN immediately reopens the breaker
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
