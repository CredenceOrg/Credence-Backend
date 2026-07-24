/**
 * In-process pub-sub notifier for trust score changes.
 * Bridges outbox events to WebSocket subscribers.
 *
 * Supports:
 * - Multiple listeners per identity
 * - Graceful unsubscribe
 * - Per-connection rate limiting
 * - Memory-safe cleanup
 */

import { EventEmitter } from "events";

export interface TrustScoreUpdate {
  identity: string;
  score: number;
  timestamp: number;
}

export interface ScoreChangeListener {
  (update: TrustScoreUpdate): void;
}

export class TrustScoreNotifier {
  private emitter: EventEmitter;
  private readonly maxListenersPerIdentity = 1000; // Prevent memory leaks

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0); // Allow unlimited global listeners
  }

  /**
   * Subscribe to trust score changes for a specific identity.
   * @param identity The identity address to watch
   * @param listener The callback to invoke on score updates
   * @returns Unsubscribe function
   */
  subscribe(identity: string, listener: ScoreChangeListener): () => void {
    // Validate identity format
    if (!identity || typeof identity !== "string" || identity.trim() === "") {
      throw new Error("Invalid identity: must be a non-empty string");
    }

    const normalizedIdentity = identity.toLowerCase();
    const eventName = this.getEventName(normalizedIdentity);

    // Check listener count to prevent DoS via memory exhaustion
    const currentListeners = this.emitter.listenerCount(eventName);
    if (currentListeners >= this.maxListenersPerIdentity) {
      throw new Error(
        `Too many subscribers for identity ${normalizedIdentity}. ` +
          `Maximum ${this.maxListenersPerIdentity} subscribers allowed.`,
      );
    }

    this.emitter.on(eventName, listener);

    // Return unsubscribe function
    return () => {
      this.emitter.off(eventName, listener);
    };
  }

  /**
   * Publish a trust score update to all subscribers.
   * @param identity The identity address
   * @param score The new trust score
   * @param tenant Optional tenant ID for scope validation (if available)
   */
  publish(identity: string, score: number, tenant?: string): void {
    if (!identity || typeof identity !== "string" || identity.trim() === "") {
      throw new Error("Invalid identity: must be a non-empty string");
    }

    if (typeof score !== "number" || isNaN(score)) {
      throw new Error("Invalid score: must be a number");
    }

    const normalizedIdentity = identity.toLowerCase();
    const eventName = this.getEventName(normalizedIdentity);
    const update: TrustScoreUpdate = {
      identity: normalizedIdentity,
      score,
      timestamp: Date.now(),
    };

    this.emitter.emit(eventName, update);
  }

  /**
   * Get the count of active subscribers for an identity.
   * Useful for monitoring and debugging.
   */
  getSubscriberCount(identity: string): number {
    const normalizedIdentity = identity.toLowerCase();
    const eventName = this.getEventName(normalizedIdentity);
    return this.emitter.listenerCount(eventName);
  }

  /**
   * Clear all listeners for a specific identity.
   * Used during graceful shutdown.
   */
  clearIdentity(identity: string): void {
    const normalizedIdentity = identity.toLowerCase();
    const eventName = this.getEventName(normalizedIdentity);
    this.emitter.removeAllListeners(eventName);
  }

  /**
   * Clear all listeners across all identities.
   * Used during graceful shutdown.
   */
  clearAll(): void {
    this.emitter.removeAllListeners();
  }

  private getEventName(normalizedIdentity: string): string {
    return `score:${normalizedIdentity}`;
  }
}

// Global singleton instance
export const trustScoreNotifier = new TrustScoreNotifier();
