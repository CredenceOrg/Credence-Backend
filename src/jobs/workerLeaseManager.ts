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

interface LeaseSession {
  client: PoolClient
  held: boolean
  querying: boolean
  disposed: boolean
  onError: (error: Error) => void
}

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
 *    pool and calls `pg_try_advisory_lock($1)` on it.
 * 2. If the lock is acquired, the instance becomes **leader** and its
 *    `onStateChange('leader')` callback fires.  A heartbeat timer verifies
 *    the connection is still alive.
 * 3. If the lock is not immediately available (`pg_try_advisory_lock`
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

  private lease: LeaseSession | null = null
  private generation = 0
  private acquisition: { generation: number; promise: Promise<void> } | null = null
  private stopping: Promise<void> | null = null
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
    if (!Number.isSafeInteger(this.lockKey)) {
      throw new RangeError('lockKey must be a safe integer')
    }
    for (const [name, value] of [['retryIntervalMs', this.retryIntervalMs], ['heartbeatIntervalMs', this.heartbeatIntervalMs]] as const) {
      if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new RangeError(`${name} must be an integer between 1 and 2147483647`)
      }
    }
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
    // A restart must not race the previous session's unlock/return to pool.
    if (this.stopping) await this.stopping
    if (this.running) {
      await this.acquisition?.promise
      return
    }
    this.running = true
    this.generation++
    this.safeLog(`[WorkerLease] Starting (lockKey=${this.lockKey}, retry=${this.retryIntervalMs}ms)`)

    // Attempt acquisition immediately
    await this.tryAcquire()
  }

  /**
   * Stop the lease manager, release the advisory lock, and clean up timers.
   */
  async stop(): Promise<void> {
    if (this.stopping) {
      await this.stopping
      return
    }
    if (!this.running) return
    this.running = false
    this.generation++
    this.clearTimers()
    const lease = this.lease
    this.lease = null
    let finished!: () => void
    const stopping = new Promise<void>(resolve => { finished = resolve })
    this.stopping = stopping
    // Revoke observable leadership before cleanup or any observer runs.
    this.setState('standby')
    try {
      await this.releaseLock(lease)
    } finally {
      finished()
      if (this.stopping === stopping) this.stopping = null
      this.safeLog('[WorkerLease] Stopped')
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async tryAcquire(): Promise<void> {
    if (!this.running) return
    if (this.acquisition?.generation === this.generation) {
      await this.acquisition.promise
      return
    }
    const acquisition = { generation: this.generation, promise: Promise.resolve() }
    acquisition.promise = this.acquireSession(acquisition.generation)
    this.acquisition = acquisition
    try {
      await acquisition.promise
    } finally {
      if (this.acquisition === acquisition) this.acquisition = null
    }
  }

  private async acquireSession(generation: number): Promise<void> {
    let lease: LeaseSession | null = null
    try {
      const client = await this.pool.connect()
      const session: LeaseSession = {
        client, held: false, querying: false, disposed: false,
        onError: error => this.loseLease(session, generation, error, 'connection'),
      }
      lease = session
      // A stopped/restarted run owns neither this connection nor future
      // results from it. Return late connections without querying them.
      if (!this.running || this.generation !== generation) {
        this.disposeSession(session, false)
        return
      }
      this.lease = session
      client.on('error', session.onError)
      session.querying = true
      const { rows } = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [this.lockKey],
      )
      session.querying = false
      if (!this.isCurrent(session, generation)) {
        this.disposeSession(session, true)
        return
      }
      const acquired = rows[0]?.acquired
      if (typeof acquired !== 'boolean') {
        throw new Error('Invalid advisory-lock acquisition response')
      }
      if (!acquired) {
        // Standby workers must not exhaust the pool while waiting for a
        // different session to release leadership.
        this.disposeSession(session, false)
        this.safeLog('[WorkerLease] Leadership unavailable — retrying')
        this.scheduleRetry()
        return
      }
      session.held = true
      this.safeLog(`[WorkerLease] Acquired leadership (lockKey=${this.lockKey})`)
      this.setState('leader')
      if (!this.isCurrent(session, generation)) return
      this.notify(() => this.events.onAcquired?.())
      if (this.isCurrent(session, generation)) this.startHeartbeat(session, generation)
    } catch (err) {
      if (lease && this.isCurrent(lease, generation)) {
        this.loseLease(lease, generation, err, 'acquisition')
      } else if (!lease && this.running && this.generation === generation) {
        this.reportError(err, 'pool connection')
        this.scheduleRetry()
      }
    }
  }

  private startHeartbeat(lease: LeaseSession, generation: number): void {
    this.clearTimers()

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat(lease, generation)
    }, this.heartbeatIntervalMs)
  }

  private async heartbeat(lease: LeaseSession, generation: number): Promise<void> {
    if (!this.isCurrent(lease, generation) || this.state !== 'leader' || lease.querying) return

    lease.querying = true
    try {
      // Verify connection is alive — if the backend session dropped, this
      // will throw and we re-enter standby.
      await lease.client.query('SELECT 1')
    } catch (err) {
      this.loseLease(lease, generation, err, 'heartbeat')
    } finally {
      lease.querying = false
    }
  }

  private isCurrent(lease: LeaseSession, generation: number): boolean {
    return this.running && this.generation === generation && this.lease === lease && !lease.disposed
  }

  private loseLease(lease: LeaseSession, generation: number, error: unknown, phase: string): void {
    if (!this.isCurrent(lease, generation)) return
    this.generation++
    this.clearTimers()
    this.disposeSession(lease, true)
    this.setState('standby')
    if (lease.held) this.notify(() => this.events.onReleased?.())
    this.reportError(error, phase)
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (!this.running) return

    this.clearTimers()
    this.retryTimer = setTimeout(() => {
      void this.tryAcquire()
    }, this.retryIntervalMs)
  }

  private async releaseLock(lease: LeaseSession | null): Promise<void> {
    if (!lease || lease.disposed) return
    let unlocked = false
    try {
      // Never queue an unlock behind an unbounded pending query. Destroy
      // that session instead; session closure releases advisory locks.
      if (lease.held && !lease.querying) {
        lease.querying = true
        const { rows } = await lease.client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1) AS unlocked', [this.lockKey])
        unlocked = rows[0]?.unlocked === true
        if (!unlocked) this.reportError(new Error('Unlock was not confirmed'), 'unlock')
      }
    } catch (err) {
      this.reportError(err, 'unlock')
    } finally {
      // Returning a session with uncertain lock ownership would leak a
      // session lock into unrelated pool users. Only confirmed unlocks
      // are safe to reuse; all other paths destroy the session exactly once.
      this.disposeSession(lease, !unlocked)
      if (lease.held) this.notify(() => this.events.onReleased?.())
    }
  }

  private disposeSession(lease: LeaseSession, destroy: boolean): void {
    if (lease.disposed) return
    lease.disposed = true
    if (this.lease === lease) this.lease = null
    lease.client.removeListener('error', lease.onError)
    try {
      if (destroy) lease.client.release(true)
      else lease.client.release()
    } catch {
      this.safeLog('[WorkerLease] Client release failed')
    }
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
    this.safeLog(`[WorkerLease] State: ${prev} → ${newState}`)
    this.notify(() => this.events.onStateChange?.(newState))
  }

  private reportError(error: unknown, phase: string): void {
    // Keep raw errors available to the existing callback contract, while
    // internal logs contain only a known phase, never DSNs or credentials.
    this.safeLog(`[WorkerLease] ${phase} failed`)
    this.notify(() => this.events.onError?.(error instanceof Error ? error : new Error('Lease operation failed')))
  }

  private notify(callback: () => void): void {
    try {
      // The public callbacks remain void callbacks. Observe a promise if
      // an existing caller supplies an async function, without letting
      // its rejection escape a timer or interrupt resource cleanup.
      void Promise.resolve(callback()).catch(() => this.safeLog('[WorkerLease] Lifecycle callback failed'))
    } catch {
      this.safeLog('[WorkerLease] Lifecycle callback failed')
    }
  }

  private safeLog(message: string): void {
    try {
      this.log(message)
    } catch {
      // Observability must not change lock ownership or prevent cleanup.
    }
  }
}
