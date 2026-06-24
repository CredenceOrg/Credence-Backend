import type { EmailProvider, NotificationProviderHealth } from './types.js'

/**
 * Tracks transient provider failures and temporarily deprioritizes unhealthy providers.
 */
export class NotificationProviderHealthTracker {
  private readonly states = new Map<string, NotificationProviderHealth>()

  constructor(
    private readonly cooldownMs: number = 30_000,
    private readonly failureThreshold: number = 1,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Returns providers ordered by health, preserving the input order among equals.
   */
  orderProviders(providers: EmailProvider[]): EmailProvider[] {
    const timestamp = this.now()

    return [...providers].sort((left, right) => {
      const leftState = this.states.get(left.name)
      const rightState = this.states.get(right.name)
      const leftUnhealthy = (leftState?.unhealthyUntil?.getTime() ?? 0) > timestamp
      const rightUnhealthy = (rightState?.unhealthyUntil?.getTime() ?? 0) > timestamp

      if (leftUnhealthy === rightUnhealthy) {
        return 0
      }

      return leftUnhealthy ? 1 : -1
    })
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
    })
  }

  /**
   * Clears provider health penalties after a successful delivery.
   */
  recordSuccess(provider: string): void {
    this.states.set(provider, {
      provider,
      consecutiveFailures: 0,
    })
  }

  /**
   * Returns the current provider health snapshot.
   */
  getHealth(provider: string): NotificationProviderHealth {
    return this.states.get(provider) ?? {
      provider,
      consecutiveFailures: 0,
    }
  }
}
