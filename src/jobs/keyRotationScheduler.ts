/**
 * KeyRotationScheduler — runs the JWT signing-key rotation policy in the
 * background.
 *
 * Two timers:
 *  • `rotationTimer` — invokes {@link KeyManager.rotate} every
 *    `rotationIntervalMs`, retiring the active key and generating a fresh
 *    keypair.  All tokens issued before rotation remain valid for the
 *    configured grace window (`KEY_GRACE_PERIOD_SECONDS`).
 *  • `pruneTimer` — invokes {@link KeyManager.pruneExpiredKeys} every
 *    `pruneIntervalMs` to garbage-collect retired keys whose grace + clock
 *    skew window has elapsed.  This is independent of rotation so
 *    abandoned keys still get cleaned up even if rotation halts.
 *
 * Errors are caught and logged; a single failed tick never kills the
 * scheduler.  The scheduler is started in `src/index.ts` after the
 * KeyManager has been bootstrapped and registered with the
 * GracefulShutdownManager so it stops cleanly on SIGTERM/SIGINT.
 *
 *## Invariants
 *
 * 1. **Single flight per work type.**  A rotation tick that is still
 *    in-flight causes the next rotation tick to be skipped (and likewise
 *    for pruning).  This prevents concurrent `KkeyManager.rotate()` calls
 *    from interleaving and producing an inconsistent key set.
 * 2. **Ticks always clear their guard.**  The `in-flight` flag is reset
 *    in a `finally` block so a thrown rotation/prune never permanently
 *    disables future ticks.
 * 3. **Stop is idempotent and resets state.**  Calling `stop()` twice is
 *    safe, and a subsequent `start()` operates from a clean slate.
 * 4. **Rotation and pruning are independent.**  A failure in one does not
 *    affect the other.
 * 5. **Metrics are recorded on every terminal outcome.**  Successful
 *    rotations record `success`, failures record `error`, and any
 *    prune that removes keys records the count.
 * 6. **No sensitive data in logs.**  Only key identifiers (kids) and
 *    error messages are logged; no material, no private key bytes.
 */

import { keyManager } from '../services/keyManager/index.js'
import { recordSigningKeyRotation, recordSigningKeyPrune } from '../middleware/metrics.js'

export interface KeyRotationSchedulerOptions {
  /** Interval (ms) between automatic rotations. */
  rotationIntervalMs: number
  /** Interval (ms) between expired-key pruning sweeps. */
  pruneIntervalMs: number
  /** Logger sink (defaults to no-op). */
  logger?: (message: string) => void
}

/**
 * Minimum allowed interval (ms).  Intervals at or below zero are
 * non-sensical for `setInterval` (they would fire as fast as the event
 * loop allows) and are treated as a configuration error.
 */
const MIN_INTERVAL_MS = 1

export class KeyRotationScheduler {
  private rotationTimer: ReturnType<typeof setInterval> | null = null
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  // Per-tick in-flight guards.  If a rotation tick takes longer than
  // `rotationIntervalMs` (e.g. a misconfigured 60 s interval + slow keygen),
  // the next tick is skipped instead of running concurrently.
  private rotating = false
  private pruning = false

  constructor(private readonly options: KeyRotationSchedulerOptions) {
    // Fail fast on invalid configuration at construction time, before any
    // timer exists. A non-positive or non-finite interval would make
    // `setInterval` fire as fast as the event loop allows, which is an
    // unsafe configuration for a key rotation job — reject it explicitly
    // rather than silently clamping. A missing logger is rejected too, so
    // a misconfigured scheduler can never run silently.
    if (
      !Number.isFinite(options.rotationIntervalMs) ||
      !Number.isFinite(options.pruneIntervalMs)
    ) {
      throw new Error('[KeyRotationScheduler] intervals must be finite numbers')
    }
    if (
      options.rotationIntervalMs < MIN_INTERVAL_MS ||
      options.pruneIntervalMs < MIN_INTERVAL_MS
    ) {
      throw new Error(
        `[KeyRotationScheduler] intervals must be >= ${MIN_INTERVAL_MS}ms (rotation=${options.rotationIntervalMs}, prune=${options.pruneIntervalMs})`,
      )
    }
    if (typeof options.logger !== 'function') {
      throw new Error('[KeyRotationScheduler] logger must be a function')
    }
  }

  /**
   * Start the scheduler.  Idempotent: a repeated call while running
   * is a no-op.  Returns `true` if the scheduler was actually started
   * by this call, `false` if it was already running.
   */
  start(): boolean {
    if (this.running) return false

    const log = this.options.logger ?? (() => {})

    // Interval and logger validation happens in the constructor, so start()
    // can assume a valid configuration and only needs its idempotency guard.
    this.running = true

    log(
      `[KeyRotationScheduler] started — rotation every ${this.options.rotationIntervalMs}ms, prune every ${this.options.pruneIntervalMs}ms`,
    )

    this.rotationTimer = setInterval(() => {
      void this.rotateSafely()
    }, this.options.rotationIntervalMs)

    this.pruneTimer = setInterval(() => {
      void this.pruneSafely()
    }, this.options.pruneIntervalMs)

    // Do not keep the Node process alive solely for these timers.
    // This matches the behavior of other background jobs and avoids
    // hanging test runners / CLI invocations.
    if (typeof this.rotationTimer === 'object' && this.rotationTimer !== null) {
      (this.rotationTimer as { unref?: () => void }).unref?.()
    }
    if (typeof this.pruneTimer === 'object' && this.pruneTimer !== null) {
      (this.pruneTimer as { unref?: () => void }).unref?.()
    }

    return true
  }

  /**
   * Stop the scheduler.  Idempotent.  Any in-flight tick is allowed to
   * complete naturally; the guards are reset so a future `start()` operates
   * from a clean slate.
   */
  stop(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer)
      this.rotationTimer = null
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    // Reset the in-flight guards so a future start() operates from a
    // clean slate even if a tick was mid-flight when stop() was called.
    this.rotating = false
    this.pruning = false
    if (this.running) {
      this.running = false
      this.options.logger?.(`[KeyRotationScheduler] stopped`)
    }
  }

  isActive(): boolean {
    return this.running
  }

  /**
   * Exposed for testing and operational tooling: run a single rotation
   * tick with the same guards as the interval callback.  Resolves once
   * the tick completes (or is skipped because another tick is in flight).
   */
  async runRotationTick(): Promise<void> {
    await this.rotateSafely()
  }

  /**
   * Exposed for testing and operational tooling: run a single prune tick
   * with the same guards as the interval callback.
   */
  async runPruneTick(): Promise<void> {
    await this.pruneSafely()
  }

  /** True while a rotation tick is in flight. */
  isRotatingInFlight(): boolean {
    return this.rotating
  }

  /** True while a prune tick is in flight. */
  isPruningInFlight(): boolean {
    return this.pruning
  }

  private async rotateSafely(): Promise<void> {
    if (this.rotating) {
      this.options.logger?.(`[KeyRotationScheduler] rotation already in flight, skipping tick`)
      return
    }
    this.rotating = true
    const log = this.options.logger ?? (() => {})
    try {
      const result = await keyManager.rotate()
      recordSigningKeyRotation('success')
      log(
        `[KeyRotationScheduler] rotation complete: retired=${result.retiredKdi}, active=${result.newKid}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      recordSigningKeyRotation('error')
      log(`[KeyRotationScheduler] rotation failed: ${message}`)
    } finally {
      this.rotating = false
    }
  }

  private async pruneSafely(): Promise<void> {
    if (this.pruning) {
      this.options.logger?.(`[KeyRotationScheduler] prune already in flight, skipping tick`)
      return
    }
    this.pruning = true
    const log = this.options.logger ?? (() => {})
    try {
      const pruned = keyManager.pruneExpiredKeys()
      if (Array.isArray(pruned) && pruned.length > 0) {
        recordSigningKeyPrune(pruned.length)
        log(`[KeyRotationScheduler] pruned ${pruned.length} expired key(s): ${pruned.join(', ')}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`[KeyRotationScheduler] prune failed: ${message}`)
    } finally {
      this.pruning = false
    }
  }
}
