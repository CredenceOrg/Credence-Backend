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

export class KeyRotationScheduler {
  private rotationTimer: ReturnType<typeof setInterval> | null = null
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  // Per-tick in-flight guards.  If a rotation tick takes longer than
  // `rotationIntervalMs` (e.g. a misconfigured 60 s interval + slow keygen),
  // the next tick is skipped instead of running concurrently.
  private rotating = false
  private pruning = false

  constructor(private readonly options: KeyRotationSchedulerOptions) {}

  start(): void {
    if (this.running) return
    this.running = true

    const log = this.options.logger ?? (() => {})

    log(
      `[KeyRotationScheduler] started — rotation every ${this.options.rotationIntervalMs}ms, prune every ${this.options.pruneIntervalMs}ms`,
    )

    this.rotationTimer = setInterval(() => {
      void this.rotateSafely()
    }, this.options.rotationIntervalMs)

    this.pruneTimer = setInterval(() => {
      void this.pruneSafely()
    }, this.options.pruneIntervalMs)
  }

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
        `[KeyRotationScheduler] rotation complete: retired=${result.retiredKid}, active=${result.newKid}`,
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
      if (pruned.length > 0) {
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
