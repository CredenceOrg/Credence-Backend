import type { EmailProvider, NotificationProviderHealth } from './types.js'
import { PROVIDER_RECOVERY_BUFFER_MS } from '../../config/constants.js'

interface InternalHealthState {
  provider: string
  consecutiveFailures: number
  unhealthyUntil?: Date
  recoveredAt?: number
}

/**
 * Tracks transient provider failures and temporarily deprioritizes unhealthy providers.
 *
 * After a provider's cooldown expires it enters a "recovering" state during which
 * it is placed behind fully-healthy providers. This spreads the re-introduction of
 * traffic and avoids a thundering herd against a just-recovered provider.
 */
export class NotificationProviderHealthTracker {
  private readonly states = new Map<string, InternalHealthState>()

  constructor(
    private readonly cooldownMs: number = 30_000,
    private readonly failureThreshold: number = 1,
    private readonly recoveryBufferMs: number = PROVIDER_RECOVERY_BUFFER_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Returns providers ordered by health, preserving the input order among equals.
   * Healthy providers come first, then recovering providers (cooldown just expired),
   * then unhealthy providers (still in cooldown).
   */
  orderProviders(providers: EmailProvider[]): EmailProvider[] {
    const timestamp = this.now()

    return [...providers].sort((left, right) => {
      const leftState = this.states.get(left.name)
      const rightState = this.states.get(right.name)
      const leftCategory = this.providerCategory(leftState, timestamp)
      const rightCategory = this.providerCategory(rightState, timestamp)

      if (leftCategory !== rightCategory) {
        return leftCategory - rightCategory
      }

      return 0
    })
  }

  private providerCategory(
    state: InternalHealthState | undefined,
    timestamp: number
  ): number {
    if (!state) return 0 // healthy
    const unhealthyUntil = state.unhealthyUntil?.getTime() ?? 0
    if (unhealthyUntil > timestamp) return 2 // unhealthy
    const recoveredAt = state.recoveredAt ?? 0
    if (recoveredAt > 0 && timestamp - recoveredAt < this.recoveryBufferMs) return 1 // recovering
    return 0 // healthy
  }

  /**
   * Marks a provider failure and opens a short cooldown for transient failures.
   */
  recordFailure(provider: string, transient: boolean): void {
    const current = this.states.get(provider) ?? {
      provider,
      consecutiveFailures: 0,
    }
    const consecutiveFailures = current.consecutiveFailures + 1

    this.states.set(provider, {
      provider,
      consecutiveFailures,
      unhealthyUntil:
        transient && consecutiveFailures >= this.failureThreshold
          ? new Date(this.now() + this.cooldownMs)
          : current.unhealthyUntil,
      recoveredAt: current.recoveredAt,
    })
  }

  /**
   * Clears provider health penalties after a successful delivery.
   * If the provider had been unhealthy, records the recovery timestamp
   * so that the recovery buffer applies.
   */
  recordSuccess(provider: string): void {
    const current = this.states.get(provider)
    const wasUnhealthy = current !== undefined && current.consecutiveFailures > 0

    this.states.set(provider, {
      provider,
      consecutiveFailures: 0,
      unhealthyUntil: undefined,
      recoveredAt: wasUnhealthy ? this.now() : undefined,
    })
  }

  /**
   * Returns the current provider health snapshot.
   */
  getHealth(provider: string): NotificationProviderHealth {
    const state = this.states.get(provider) ?? {
      provider,
      consecutiveFailures: 0,
    }
    return {
      provider: state.provider,
      consecutiveFailures: state.consecutiveFailures,
      unhealthyUntil: state.unhealthyUntil,
    }
  }

  /**
   * Returns true if the provider is currently in the recovery buffer window.
   */
  isRecovering(provider: string): boolean {
    const state = this.states.get(provider)
    if (!state) return false
    return this.providerCategory(state, this.now()) === 1
  }
}
