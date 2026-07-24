import type { Pool, PoolClient } from 'pg'
import { logger } from '../utils/logger.js'

/**
 * Advisory lock key used for outbox worker leadership.
 *
 * All outbox publisher instances use this same integer so that only one can
 * hold the lock at a time.  The value is an arbitrary but stable constant
 * chosen to avoid collision with other advisory-lock users in the system.
 */
export const OUTBOX_LEADER_LOCK_KEY = 53_81

export interface WorkerLeaseManagerOptions {
  /** Postgres connection pool. */
  pool: Pool
  /** Advisory lock key.  Default: {@link OUTBOX_LEADER_LOCK_KEY}. */
  lockKey?: number
  /** How often (ms) to attempt acquisition when in standby mode.  Default: 5000. */
  retryIntervalMs?: number
  /** How often (ms) to heartbeat / verify ownership while leader.  Default: 10000. */
  heartbeatIntervalMs?: number
  /** Clock injection for deterministic tests. */
  now?: () => Date
  /** Logger override. */
  log?: (msg: string) => void
}

export type WorkerLeaseState = 'standby' | 'leader'

export interface WorkerLeaseEvents {
  onStateChange?: (state: WorkerLeaseState) => void
  onAcquired?: () => void
  onReleased?: () => void
  onError?: (error: Error) => void
}

/**
 * Ensures only one outbox publisher instance runs at a time by using a
 * Postgres session-level advisory lock.
 *
 * ### How it works
 *
 * 1. On `start()`, the manager checks out a dedicated connection from the
 *    pool and calls `pg_advisory_lock($1)` on it.
 * 2. If the lock is acquired, the instance becomes **leader** and its
 *    `onStateChange('leader')` callback fires.  A heartbeat timer verifies
 *    the connection is still alive.
 * 3. If the lock is not immediately available (`pg_advisory_try_lock`
 *    returns false), the instance stays in **standby** and retries every
 *    `retryIntervalMs`.
 * 4. On `stop()`, the manager calls `pg_advisory_unlock($1)` and releases
 *    the connection back to the pool.
 * 5. If the dedicated connection drops (DB restart, network partition), the
 *    advisory lock is automatically released by Postgres.  The heartbeat
 *    detects the broken connection, releases the client, and re-enters
 *    standby mode to retry.
 *
 * Advisory locks are **session-level** — the lock lives as long as the
 * underlying Postgres backend session.  This is ideal for long-lived
 * leader ownership because there is no TTL-based expiry to manage; the
 * lock is held until the connection is explicitly closed or lost.
 */
export class WorkerLeaseManager {
  private readonly pool: Pool
  private readonly lockKey: number
  private readonly retryIntervalMs: number
  private readonly heartbeatIntervalMs: number
  private readonly now: () => Date
  private readonly log: (msg: string) => void

  private client: PoolClient | null = null
  private running = false
  private state: WorkerLeaseState = 'standby'
  private retryTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private events: WorkerLeaseEvents = {}

  constructor(opts: WorkerLeaseManagerOptions) {
    this.pool = opts.pool
    this.lockKey = opts.lockKey ?? OUTBOX_LEADER_LOCK_KEY
    this.retryIntervalMs = opts.retryIntervalMs ?? 5_000
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 10_000
    this.now = opts.now ?? (() => new Date())
    this.log = opts.log ?? ((msg) => logger.info(msg))
  }

  /** Current leadership state. */
  get currentState(): WorkerLeaseState {
    return this.state
  }

  /** Register lifecycle callbacks. */
  on(events: WorkerLeaseEvents): void {
    this.events = { ...this.events, ...events }
  }

  /**
   * Start the lease manager.  Attempts to acquire the advisory lock
   * immediately and begins retrying if unsuccessful.
   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.log(`[WorkerLease] Starting (lockKey=${this.lockKey}, retry=${this.retryIntervalMs}ms)`)

    // Attempt acquisition immediately
    await this.tryAcquire()
  }

  /**
   * Stop the lease manager, release the advisory lock, and clean up timers.
   */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false

    this.clearTimers()
    await this.releaseLock()
    this.setState('standby')
    this.log('[WorkerLease] Stopped')
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async tryAcquire(): Promise<void> {
    if (!this.running) return

    // Ensure we have a dedicated connection
    if (!this.client) {
      try {
        this.client = await this.pool.connect()
      } catch (err) {
        this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
        this.scheduleRetry()
        return
      }
    }

    try {
      const { rows } = await this.client.query<{ pg_advisory_lock: boolean }>(
        'SELECT pg_advisory_lock($1) AS pg_advisory_lock',
        [this.lockKey],
      )

      const acquired = rows[0]?.pg_advisory_lock === true
      if (acquired) {
        this.log(`[WorkerLease] Acquired leadership (lockKey=${this.lockKey})`)
        this.setState('leader')
        this.events.onAcquired?.()
        this.startHeartbeat()
        return
      }

      // pg_advisory_lock blocks until acquired, so reaching here is
      // unexpected with session-level locks.  Log and retry.
      this.log('[WorkerLease] pg_advisory_lock returned unexpected false — retrying')
      this.scheduleRetry()
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
      await this.releaseClient()
      this.scheduleRetry()
    }
  }

  private startHeartbeat(): void {
    this.clearTimers()

    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((err) => {
        this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
      })
    }, this.heartbeatIntervalMs)
  }

  private async heartbeat(): Promise<void> {
    if (!this.running || this.state !== 'leader' || !this.client) return

    try {
      // Verify connection is alive — if the backend session dropped, this
      // will throw and we re-enter standby.
      await this.client.query('SELECT 1')
    } catch {
      this.log('[WorkerLease] Heartbeat failed — connection lost, reverting to standby')
      await this.releaseClient()
      this.setState('standby')
      this.events.onReleased?.()
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (!this.running) return

    this.clearTimers()
    this.retryTimer = setTimeout(() => {
      void this.tryAcquire()
    }, this.retryIntervalMs)
  }

  private async releaseLock(): Promise<void> {
    if (!this.client) return

    try {
      await this.client.query('SELECT pg_advisory_unlock($1)', [this.lockKey])
      this.log(`[WorkerLease] Released advisory lock (lockKey=${this.lockKey})`)
      this.events.onReleased?.()
    } catch {
      // Connection may already be dead — nothing to do
    } finally {
      await this.releaseClient()
    }
  }

  private async releaseClient(): Promise<void> {
    if (!this.client) return
    try {
      this.client.release()
    } catch {
      // ignore
    }
    this.client = null
  }

  private clearTimers(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private setState(newState: WorkerLeaseState): void {
    if (this.state === newState) return
    const prev = this.state
    this.state = newState
    this.events.onStateChange?.(newState)
    this.log(`[WorkerLease] State: ${prev} → ${newState}`)
  }
}
