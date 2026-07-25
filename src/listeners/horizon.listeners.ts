// src/listeners/horizon.listeners.ts
//
// Horizon event listener with a lease/heartbeat row for controlled failover.
//
// Original behaviour (a single cursor + reconnect backoff) is preserved
// through `HorizonListener.handleEvent`.  The new `LeaseManager` and
// `LeasedHorizonListener` make it possible to run two instances side-by-side
// where only one actively processes events at a time:
//
//   1.  On start, each instance tries to `acquire()` the lease for its
//       stream.  Acquisition is an atomic UPSERT that succeeds only if the
//       existing row is unowned, expired, or already owned by this instance.
//   2.  While processing, the active owner calls `heartbeat()` on an
//       interval to push out `lease_expires_at`.
//   3.  If the primary pauses/dies, the lease expires and a waiting
//       standby's `acquire()` will steal it — bumping `fencing_token` so any
//       zombie primary's cursor write is rejected (split-brain protection).
//   4.  Cursor checkpoints (`updateCursor`) are guarded by the fencing
//       token, so an in-flight event from an evicted owner cannot move the
//       cursor backwards.
//
// The drill script `scripts/horizon-failover-drill.ts` exercises all three
// edge cases called out in the issue: split-brain, expired-lease while
// processing, and replay of an in-flight event.
//
import { dbRepository } from '../db/repository.js'
import type { Queryable } from '../db/repositories/queryable.js'

// ---------------------------------------------------------------------------
// Public event model — unchanged from the original implementation.
// ---------------------------------------------------------------------------

export interface HorizonEvent {
  type: string
  nodeId?: string
  amount?: string
  penalty?: string
  timestamp?: string
  /** Optional Horizon paging token for cursor advancement. */
  pagingToken?: string
}

// ---------------------------------------------------------------------------
// Lease / heartbeat
// ---------------------------------------------------------------------------

export interface LeaseRow {
  streamName: string
  ownerId: string
  pagingToken: string
  leaseExpiresAt: Date
  heartbeatAt: Date
  fencingToken: number
}

export interface LeaseAcquireResult {
  acquired: boolean
  lease: LeaseRow | null
  /** Populated when `acquired === false` so the caller can log why. */
  reason?: 'held-by-other' | 'db-error'
}

export interface LeaseManagerOptions {
  /** Logical stream name, e.g. `bond_creation`. */
  streamName: string
  /** Unique id for this process — usually `${hostname}:${pid}`. */
  ownerId: string
  /** Lease TTL in ms.  Standby will attempt steal once expired. */
  ttlMs?: number
  /** Heartbeat interval in ms.  Must be < ttlMs / 2 for safe handoff. */
  heartbeatMs?: number
  /** Clock injection point for deterministic tests. */
  now?: () => Date
}

/**
 * Thin repository over the `listener_leases` table created by
 * migration 011.  Kept dependency-free so the failover drill and unit tests
 * can drive it with an in-memory `Queryable` shim.
 */
export class LeaseManager {
  readonly streamName: string
  readonly ownerId: string
  readonly ttlMs: number
  readonly heartbeatMs: number
  private readonly now: () => Date
  private currentFencingToken = 0

  constructor(
    private readonly db: Queryable,
    opts: LeaseManagerOptions,
  ) {
    this.streamName = opts.streamName
    this.ownerId = opts.ownerId
    this.ttlMs = opts.ttlMs ?? 15_000
    this.heartbeatMs = opts.heartbeatMs ?? 5_000
    this.now = opts.now ?? (() => new Date())

    if (this.heartbeatMs * 2 > this.ttlMs) {
      throw new Error(
        `LeaseManager: heartbeatMs (${this.heartbeatMs}) must be < ttlMs/2 (${this.ttlMs / 2})`,
      )
    }
  }

  /** Last fencing token observed by this instance.  Zero before acquire. */
  get fencingToken(): number {
    return this.currentFencingToken
  }

  /**
   * Attempt to acquire the lease.  Returns `{ acquired: true }` if this
   * instance now owns the stream, otherwise reports who holds it.
   *
   * The UPSERT below is the only critical section in the failover path —
   * Postgres' row-level conflict resolution gives us atomicity for free.
   */
  async acquire(): Promise<LeaseAcquireResult> {
    const now = this.now()
    const expires = new Date(now.getTime() + this.ttlMs)

    try {
      const { rows } = await this.db.query<{
        stream_name: string
        owner_id: string
        paging_token: string
        lease_expires_at: Date
        heartbeat_at: Date
        fencing_token: string | number
        acquired: boolean
      }>(
        `
        INSERT INTO listener_leases
          (stream_name, owner_id, paging_token, lease_expires_at, heartbeat_at, fencing_token, updated_at)
        VALUES ($1, $2, '0', $3, $4, 1, $4)
        ON CONFLICT (stream_name) DO UPDATE
          SET owner_id         = EXCLUDED.owner_id,
              lease_expires_at = EXCLUDED.lease_expires_at,
              heartbeat_at     = EXCLUDED.heartbeat_at,
              fencing_token    = listener_leases.fencing_token + 1,
              updated_at       = EXCLUDED.updated_at
          WHERE listener_leases.owner_id = EXCLUDED.owner_id
             OR listener_leases.lease_expires_at <= EXCLUDED.heartbeat_at
        RETURNING
          stream_name,
          owner_id,
          paging_token,
          lease_expires_at,
          heartbeat_at,
          fencing_token,
          (owner_id = $2) AS acquired
        `,
        [this.streamName, this.ownerId, expires, now],
      )

      if (rows.length === 0 || !rows[0].acquired) {
        // Conflict not resolved — someone else still owns the lease.
        const existing = await this.peek()
        return { acquired: false, lease: existing, reason: 'held-by-other' }
      }

      const lease = this.rowToLease(rows[0])
      this.currentFencingToken = lease.fencingToken
      return { acquired: true, lease }
    } catch {
      return { acquired: false, lease: null, reason: 'db-error' }
    }
  }

  /** Push the lease expiry forward.  No-op if we no longer own the lease. */
  async heartbeat(): Promise<boolean> {
    const now = this.now()
    const expires = new Date(now.getTime() + this.ttlMs)

    const { rowCount } = await this.db.query(
      `
      UPDATE listener_leases
         SET lease_expires_at = $3,
             heartbeat_at     = $4,
             updated_at       = $4
       WHERE stream_name  = $1
         AND owner_id     = $2
         AND fencing_token = $5
      `,
      [this.streamName, this.ownerId, expires, now, this.currentFencingToken],
    )
    return (rowCount ?? 0) > 0
  }

  /**
   * Gracefully release the lease so a standby can take over immediately.
   * Safe to call multiple times.
   */
  async release(): Promise<void> {
    await this.db.query(
      `
      UPDATE listener_leases
         SET lease_expires_at = heartbeat_at,
             updated_at       = $3
       WHERE stream_name  = $1
         AND owner_id     = $2
      `,
      [this.streamName, this.ownerId, this.now()],
    )
  }

  /**
   * Persist the latest paging token under fencing-token protection.
   *
   * Returns `true` if the cursor moved.  A `false` result means the caller
   * lost the lease while processing — the in-flight event MUST be retried
   * by the new owner rather than acknowledged here.
   */
  async updateCursor(pagingToken: string): Promise<boolean> {
    if (!/^\d+$/.test(pagingToken) && pagingToken !== 'now') {
      throw new Error(`Invalid paging_token: ${pagingToken}`)
    }
    const { rowCount } = await this.db.query(
      `
      UPDATE listener_leases
         SET paging_token = $3,
             updated_at   = $4
       WHERE stream_name  = $1
         AND owner_id     = $2
         AND fencing_token = $5
      `,
      [this.streamName, this.ownerId, pagingToken, this.now(), this.currentFencingToken],
    )
    return (rowCount ?? 0) > 0
  }

  /** Read-only lookup for monitoring / drill verification. */
  async peek(): Promise<LeaseRow | null> {
    const { rows } = await this.db.query<{
      stream_name: string
      owner_id: string
      paging_token: string
      lease_expires_at: Date
      heartbeat_at: Date
      fencing_token: string | number
    }>(
      `SELECT stream_name, owner_id, paging_token,
              lease_expires_at, heartbeat_at, fencing_token
         FROM listener_leases
        WHERE stream_name = $1`,
      [this.streamName],
    )
    return rows.length ? this.rowToLease(rows[0]) : null
  }

  /** Listener-lag in seconds — exposed to Prometheus / Grafana. */
  async getLagSeconds(): Promise<number | null> {
    const lease = await this.peek()
    if (!lease) return null
    return Math.max(
      0,
      Math.floor((this.now().getTime() - lease.heartbeatAt.getTime()) / 1000),
    )
  }

  private rowToLease(row: {
    stream_name: string
    owner_id: string
    paging_token: string
    lease_expires_at: Date
    heartbeat_at: Date
    fencing_token: string | number
  }): LeaseRow {
    return {
      streamName: row.stream_name,
      ownerId: row.owner_id,
      pagingToken: row.paging_token,
      leaseExpiresAt: new Date(row.lease_expires_at),
      heartbeatAt: new Date(row.heartbeat_at),
      fencingToken:
        typeof row.fencing_token === 'string'
          ? Number(row.fencing_token)
          : row.fencing_token,
    }
  }
}

// ---------------------------------------------------------------------------
// HorizonListener — backwards-compatible plus lease-aware variant.
// ---------------------------------------------------------------------------

export class HorizonListener {
  // Inject dependency for easy mocking
  constructor(private db = dbRepository) {}

  async handleEvent(event: HorizonEvent): Promise<void> {
    if (!event.nodeId || !event.type) {
      throw new Error('Malformed event payload: missing required fields')
    }

    try {
      switch (event.type) {
        case 'bond':
          if (!event.amount)
            throw new Error('Malformed event payload: missing required fields')
          await this.db.upsertNode(event.nodeId, event.amount)
          break
        case 'slash':
          if (!event.penalty)
            throw new Error('Malformed event payload: missing required fields')
          await this.db.updateNodeStatus(event.nodeId, 'slashed', event.penalty)
          break
        case 'withdrawal':
          await this.db.updateNodeStatus(event.nodeId, 'withdrawn')
          break
        default:
          console.log(`Ignored unknown event type: ${event.type}`)
          break
      }
    } catch (error) {
      throw error // Re-throw to allow tests to catch DB failures
    }
  }
}

export interface LeasedHorizonListenerOptions extends LeaseManagerOptions {
  /** Underlying event handler.  Defaults to a fresh `HorizonListener`. */
  inner?: HorizonListener
}

/**
 * Lease-aware wrapper around `HorizonListener`.
 *
 *   const lm  = new LeaseManager(db, { streamName, ownerId })
 *   const led = new LeasedHorizonListener(lm)
 *   if ((await led.start()).acquired) {
 *     for await (const ev of stream) await led.process(ev)
 *   }
 *
 * Heartbeats are driven by the caller (so tests / drills control the
 * clock) via `led.heartbeat()`.  Production callers typically spin up a
 * `setInterval(led.heartbeat, lm.heartbeatMs)` loop.
 */
export class LeasedHorizonListener {
  readonly inner: HorizonListener
  constructor(
    readonly lease: LeaseManager,
    opts: { inner?: HorizonListener } = {},
  ) {
    this.inner = opts.inner ?? new HorizonListener()
  }

  /** Try to become the primary for this stream. */
  start(): Promise<LeaseAcquireResult> {
    return this.lease.acquire()
  }

  /**
   * Process a single event iff this instance is still the lease holder.
   * Returns `'skipped'` if the lease was lost — the caller MUST NOT ack the
   * event because the new owner will replay it.
   */
  async process(event: HorizonEvent): Promise<'processed' | 'skipped'> {
    // 1. Re-assert leadership BEFORE side-effects.
    const ok = await this.lease.heartbeat()
    if (!ok) return 'skipped'

    // 2. Apply the event.
    await this.inner.handleEvent(event)

    // 3. Advance cursor under the same fencing token.  If this returns
    //    false the lease expired mid-flight; the new owner will replay
    //    starting at the previously-checkpointed token (at-least-once).
    if (event.pagingToken) {
      const advanced = await this.lease.updateCursor(event.pagingToken)
      if (!advanced) return 'skipped'
    }
    return 'processed'
  }

  /** Send a heartbeat without processing.  Used by background timers. */
  heartbeat(): Promise<boolean> {
    return this.lease.heartbeat()
  }

  /** Hand off cleanly to a standby. */
  stop(): Promise<void> {
    return this.lease.release()
  }
}
