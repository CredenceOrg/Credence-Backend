#!/usr/bin/env tsx
/* eslint-disable no-console */
//
// scripts/horizon-failover-drill.ts
//
// Scripted failover drill for the Horizon listener lease system.
//
//   npm run drill:horizon
//
// What it does, in order:
//   1.  Starts a *primary* listener and processes a few synthetic events.
//   2.  Starts a *standby* listener that politely loses the lease race.
//   3.  Pauses the primary (stops heartbeats) and waits past the TTL.
//   4.  Asserts the standby successfully steals the lease, that the
//       fencing token advanced, and that the cursor handed off without
//       gaps or duplicates.
//   5.  Exercises the three edge cases called out in the issue:
//         a) split-brain (two leaders writing concurrently)
//         b) expired lease while processing
//         c) replay of an in-flight event from the evicted primary
//
// The drill runs entirely against an in-memory `Queryable` shim so it can
// be executed from CI without provisioning Postgres.  Swap in a real `pg`
// Pool for an end-to-end rehearsal in staging.
//
import { setTimeout as sleep } from 'node:timers/promises'

import {
  HorizonListener,
  LeaseManager,
  LeasedHorizonListener,
  type HorizonEvent,
} from '../src/listeners/horizon.listeners.js'
import { createInMemoryLeaseStore } from './horizon-failover-drill.store.js'

const STREAM = 'bond_creation'
const TTL_MS = 1_000
const HEARTBEAT_MS = 300

export interface HorizonFailoverDrillCheck {
  name: string
  ok: boolean
  detail?: string
}

export interface HorizonFailoverDrillOptions {
  now?: () => Date
  wait?: (ms: number) => Promise<void>
  store?: InMemoryLeaseStore
  onCheck?: (check: HorizonFailoverDrillCheck) => void
}

async function main(options: HorizonFailoverDrillOptions = {}): Promise<void> {
  console.log('▶ Horizon failover drill — stream:', STREAM)

  const store = options.store ?? createInMemoryLeaseStore()
  const now = options.now ?? (() => new Date())
  const wait = options.wait ?? sleep
  const results: HorizonFailoverDrillCheck[] = []
  const record = (name: string, ok: boolean, detail?: string): void => {
    const check = { name, ok, detail }
    results.push(check)
    options.onCheck?.(check)
    const icon = ok ? '✅' : '❌'
    const tail = detail ? `  — ${detail}` : ''
    console.log(`${icon} ${name}${tail}`)
  }
  const processed: Array<{ owner: string; token: string }> = []

  // ---- 1. PRIMARY UP --------------------------------------------------
  const primary = new LeasedHorizonListener(
    new LeaseManager(store, {
      streamName: STREAM,
      ownerId: 'primary',
      ttlMs: TTL_MS,
      heartbeatMs: HEARTBEAT_MS,
      now,
    }),
    { inner: new NoopHorizonListener() },
  )
  const primaryStart = await primary.start()
  record('primary acquires lease on cold start', primaryStart.acquired)

  for (const token of ['10', '20', '30']) {
    const status = await primary.process(mkEvent(token))
    if (status === 'processed') processed.push({ owner: 'primary', token })
  }
  record(
    'primary processed 3 events in order',
    processed.length === 3 && processed.every((p) => p.owner === 'primary'),
    processed.map((p) => p.token).join(','),
  )

  // ---- 2. STANDBY JOINS, LOSES RACE ----------------------------------
  let leaseExpiredDuringHandler = false
  const standby = new LeasedHorizonListener(
    new LeaseManager(store, {
      streamName: STREAM,
      ownerId: 'standby',
      ttlMs: TTL_MS,
      heartbeatMs: HEARTBEAT_MS,
      now,
    }),
    {
      inner: new NoopHorizonListener((nodeId) => {
        if (nodeId === 'node-50') {
          store.expireLease(STREAM, now())
          leaseExpiredDuringHandler = true
        }
      }),
    },
  )
  const firstClaim = await standby.start()
  record(
    'standby is blocked while primary is healthy',
    !firstClaim.acquired && firstClaim.reason === 'held-by-other',
  )

  // ---- 3. PAUSE PRIMARY, WAIT PAST TTL -------------------------------
  console.log('… pausing primary until the lease expires')
  if (options.now && options.wait) {
    await wait(TTL_MS - 1)
    const beforeExpiry = await standby.start()
    record(
      'standby remains blocked immediately before expiry',
      !beforeExpiry.acquired && beforeExpiry.reason === 'held-by-other',
    )
    await wait(1)
  } else {
    await wait(TTL_MS + 200)
  }

  const steal = await standby.start()
  record(
    options.now && options.wait
      ? 'standby steals lease at the expiry boundary'
      : 'standby steals expired lease',
    steal.acquired,
  )
  record(
    'fencing token advanced on steal',
    (steal.lease?.fencingToken ?? 0) > (primaryStart.lease?.fencingToken ?? 0),
    `primary=${primaryStart.lease?.fencingToken} → standby=${steal.lease?.fencingToken}`,
  )

  // ---- 4. EDGE CASE A — split-brain ----------------------------------
  // Evicted primary attempts to heartbeat after losing the lease.
  const zombieHeartbeat = await primary.heartbeat()
  record('split-brain: zombie primary heartbeat rejected', !zombieHeartbeat)

  // ---- 5. EDGE CASE B — expired lease while processing ---------------
  // Standby processes the next event; should succeed because it owns lease.
  const ok40 = await standby.process(mkEvent('40'))
  record('standby processes event 40 cleanly', ok40 === 'processed')
  if (ok40 === 'processed') processed.push({ owner: 'standby', token: '40' })

  // Expire the lease inside the handler so cursor persistence loses fencing.
  const midflight = await standby.process(mkEvent('50'))
  record('lease expired during event handling', leaseExpiredDuringHandler)
  record(
    'expired-lease-while-processing: result reported as "skipped"',
    midflight === 'skipped',
  )
  const afterSkipped = await standby.lease.peek()
  record(
    'skipped event does not advance the cursor',
    afterSkipped?.pagingToken === '40',
    `cursor=${afterSkipped?.pagingToken}`,
  )

  // ---- 6. EDGE CASE C — in-flight replay -----------------------------
  // A fresh owner re-acquires and replays event 50.  Cursor must not
  // regress and the event must be re-processed exactly once by the new
  // primary (at-least-once delivery, idempotent handler).
  const replayOwner = new LeasedHorizonListener(
    new LeaseManager(store, {
      streamName: STREAM,
      ownerId: 'standby-2',
      ttlMs: TTL_MS,
      heartbeatMs: HEARTBEAT_MS,
      now,
    }),
    { inner: new NoopHorizonListener() },
  )
  const replayClaim = await replayOwner.start()
  const replay = await replayOwner.process(mkEvent('50'))
  record(
    'in-flight replay: new owner re-processes event 50',
    replayClaim.acquired && replay === 'processed',
  )
  if (replay === 'processed') processed.push({ owner: 'standby-2', token: '50' })

  const final = await replayOwner.lease.peek()
  record(
    'cursor handoff: paging_token monotonically advanced to 50',
    final?.pagingToken === '50',
    `final=${final?.pagingToken}`,
  )

  // ---- SUMMARY -------------------------------------------------------
  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(`Drill complete — ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.error('FAILED CHECKS:')
    for (const f of failed) console.error(' •', f.name, f.detail ?? '')
    process.exit(1)
  }
}

function mkEvent(pagingToken: string): HorizonEvent {
  return {
    type: 'bond',
    nodeId: `node-${pagingToken}`,
    amount: '1000',
    pagingToken,
  }
}

/** No-op handler so the drill doesn't depend on a real repository. */
class NoopHorizonListener extends HorizonListener {
  constructor(onBond?: (nodeId: string) => void) {
    super({
      upsertNode: async (nodeId) => {
        onBond?.(nodeId)
        return true
      },
      updateNodeStatus: async () => true,
      // The drill only emits `bond` events (creation), which never consult
      // the current state; report a live node so the contract is satisfied.
      getNodeStatus: async () => 'active',
    })
  }
}

// Allow `tsx scripts/horizon-failover-drill.ts` and `import` from tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('horizon-failover-drill.ts')

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Drill crashed:', err)
    process.exit(1)
  })
}

export { main as runHorizonFailoverDrill }
