import { SorobanClientError } from './soroban.js'
import client from 'prom-client'
import {
  CIRCUIT_BREAKER_DEFAULTS,
  CIRCUIT_BREAKER_OPEN_WINDOW_MS,
  CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
} from '../config/sorobanConstants.js'

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

/**
 * Configuration for the Soroban RPC circuit breaker.
 *
 * The breaker operates with two independent time windows:
 *
 * - `openWindowMs`: how long the breaker stays OPEN after tripping, during
 *   which all requests are rejected immediately (fail-fast) without touching
 *   the network. Default: {@link CIRCUIT_BREAKER_OPEN_WINDOW_MS} (10 000 ms).
 *
 * - `halfOpenAfterMs`: how long after the breaker trips before a single probe
 *   request is allowed through. Must be ≥ `openWindowMs`. Default:
 *   {@link CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS} (30 000 ms).
 *
 * Timeline after tripping:
 *   0 s ──── OPEN (fail-fast) ──── 10 s ──── still OPEN ──── 30 s ──→ HALF_OPEN (probe)
 *
 * @deprecated `cooldownPeriodMs` is accepted for backwards compatibility and
 *   maps to `halfOpenAfterMs` when the new field is absent. Prefer the
 *   explicit fields in new code.
 */
export interface CircuitBreakerConfig {
  failureThreshold: number
  /**
   * Duration in milliseconds that the breaker stays OPEN and rejects all
   * requests immediately (fail-fast). Default: {@link CIRCUIT_BREAKER_OPEN_WINDOW_MS}.
   */
  openWindowMs?: number
  /**
   * Duration in milliseconds after tripping before the first probe request is
   * allowed. Must be ≥ `openWindowMs`. Default: {@link CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS}.
   */
  halfOpenAfterMs?: number
  /**
   * @deprecated Use `halfOpenAfterMs` instead.
   * Accepted for backwards compatibility; maps to `halfOpenAfterMs` when the
   * new field is not provided.
   */
  cooldownPeriodMs?: number
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
  private activeProbes = 0

  private readonly failureThreshold: number
  /** Duration for which the OPEN state rejects all requests immediately. */
  private readonly openWindowMs: number
  /** Elapsed time after tripping before a probe is attempted. */
  private readonly halfOpenAfterMs: number

  constructor(
    public readonly host: string,
    config: CircuitBreakerConfig,
  ) {
    this.failureThreshold = config.failureThreshold

    // Backwards-compat: cooldownPeriodMs → halfOpenAfterMs
    const resolvedHalfOpen =
      config.halfOpenAfterMs ??
      config.cooldownPeriodMs ??
      CIRCUIT_BREAKER_DEFAULTS.halfOpenAfterMs

    this.openWindowMs = config.openWindowMs ?? CIRCUIT_BREAKER_DEFAULTS.openWindowMs
    // Clamp: halfOpenAfterMs must be at least as long as the open window.
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

  /**
   * Checks elapsed time since the breaker tripped and transitions to
   * HALF_OPEN once `halfOpenAfterMs` has passed.
   *
   * Timeline:
   *   [0, halfOpenAfterMs) → stay OPEN
   *   [halfOpenAfterMs, ∞) → transition to HALF_OPEN
   */
  private checkTimers(): void {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt
      if (elapsed >= this.halfOpenAfterMs) {
        this.transitionTo('HALF_OPEN')
      }
    }
  }

  /**
   * Returns true once the initial fail-fast window (`openWindowMs`) has
   * elapsed but the breaker is still OPEN (waiting for the probe window).
   * Useful for surfacing a more descriptive message in logs/metrics.
   */
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

  /**
   * Executes a Soroban RPC operation within the protection of the circuit breaker.
   *
   * - CLOSED → pass through; count failures toward the threshold.
   * - OPEN   → reject immediately (fail-fast).
   * - HALF_OPEN → allow exactly one concurrent probe; others fail fast.
   */
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
