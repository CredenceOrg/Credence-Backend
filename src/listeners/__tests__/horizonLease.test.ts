// src/listeners/__tests__/horizonLease.test.ts
//
// Unit tests for the lease/heartbeat layer added to horizon.listeners.ts.
// Targets ≥95% line + branch coverage for the LeaseManager and
// LeasedHorizonListener classes.
//
import { describe, it, expect, beforeEach } from 'vitest'

import {
  HorizonListener,
  LeaseManager,
  LeasedHorizonListener,
  type HorizonEvent,
} from '../horizon.listeners.js'
import {
  createInMemoryLeaseStore,
  type InMemoryLeaseStore,
} from '../../../scripts/horizon-failover-drill.store.js'

const STREAM = 'bond_creation'

function noopListener(): HorizonListener {
  return new HorizonListener({
    upsertNode: async () => true,
    updateNodeStatus: async () => true,
  })
}

function mkEvent(token: string): HorizonEvent {
  return { type: 'bond', nodeId: `n-${token}`, amount: '1', pagingToken: token }
}

describe('LeaseManager', () => {
  let store: InMemoryLeaseStore

  beforeEach(() => {
    store = createInMemoryLeaseStore()
  })

  it('rejects unsafe ttl/heartbeat configuration', () => {
    expect(
      () =>
        new LeaseManager(store, {
          streamName: STREAM,
          ownerId: 'a',
          ttlMs: 1_000,
          heartbeatMs: 800,
        }),
    ).toThrow(/heartbeatMs/)
  })

  it('acquires a lease on a fresh stream and exposes a fencing token', async () => {
    const lm = new LeaseManager(store, {
      streamName: STREAM,
      ownerId: 'a',
      ttlMs: 1_000,
      heartbeatMs: 100,
    })
    const res = await lm.acquire()
    expect(res.acquired).toBe(true)
    expect(res.lease?.ownerId).toBe('a')
    expect(lm.fencingToken).toBeGreaterThan(0)
  })

  it('blocks a second owner while the lease is healthy', async () => {
    const a = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'a', ttlMs: 1_000, heartbeatMs: 100,
    })
    const b = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'b', ttlMs: 1_000, heartbeatMs: 100,
    })
    expect((await a.acquire()).acquired).toBe(true)
    const blocked = await b.acquire()
    expect(blocked.acquired).toBe(false)
    expect(blocked.reason).toBe('held-by-other')
    expect(blocked.lease?.ownerId).toBe('a')
  })

  it('lets the standby steal an expired lease and bumps the fencing token', async () => {
    const a = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'a', ttlMs: 500, heartbeatMs: 100,
    })
    const b = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'b', ttlMs: 500, heartbeatMs: 100,
    })
    const first = await a.acquire()
    store.expireLease(STREAM)
    const stolen = await b.acquire()
    expect(stolen.acquired).toBe(true)
    expect(stolen.lease!.fencingToken).toBeGreaterThan(first.lease!.fencingToken)
  })

  it('heartbeat is rejected after the lease is stolen (split-brain guard)', async () => {
    const a = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'a', ttlMs: 500, heartbeatMs: 100,
    })
    const b = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'b', ttlMs: 500, heartbeatMs: 100,
    })
    await a.acquire()
    store.expireLease(STREAM)
    await b.acquire()
    expect(await a.heartbeat()).toBe(false)
    expect(await b.heartbeat()).toBe(true)
  })

  it('updateCursor advances paging_token only while lease is valid', async () => {
    const a = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'a', ttlMs: 1_000, heartbeatMs: 100,
    })
    await a.acquire()
    expect(await a.updateCursor('100')).toBe(true)
    expect((await a.peek())?.pagingToken).toBe('100')

    store.expireLease(STREAM)
    expect(await a.updateCursor('200')).toBe(false)
    expect((await a.peek())?.pagingToken).toBe('100')
  })

  it('rejects malformed paging tokens', async () => {
    const a = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'a', ttlMs: 1_000, heartbeatMs: 100,
    })
    await a.acquire()
    await expect(a.updateCursor('not-a-number')).rejects.toThrow(/Invalid paging_token/)
    // 'now' is a recognised sentinel.
    expect(await a.updateCursor('now')).toBe(true)
  })

  it('release() lets a standby acquire immediately', async () => {
    const a = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'a', ttlMs: 5_000, heartbeatMs: 100,
    })
    const b = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'b', ttlMs: 5_000, heartbeatMs: 100,
    })
    await a.acquire()
    expect((await b.acquire()).acquired).toBe(false)
    await a.release()
    expect((await b.acquire()).acquired).toBe(true)
  })

  it('peek() returns null for unknown streams; getLagSeconds matches', async () => {
    const a = new LeaseManager(store, {
      streamName: STREAM, ownerId: 'a', ttlMs: 1_000, heartbeatMs: 100,
    })
    expect(await a.peek()).toBeNull()
    expect(await a.getLagSeconds()).toBeNull()
    await a.acquire()
    expect(await a.getLagSeconds()).toBeGreaterThanOrEqual(0)
  })

  it('acquire() reports db-error when the store throws', async () => {
    const broken: InMemoryLeaseStore = {
      ...store,
      query: async () => {
        throw new Error('boom')
      },
    }
    const a = new LeaseManager(broken, {
      streamName: STREAM, ownerId: 'a', ttlMs: 1_000, heartbeatMs: 100,
    })
    const res = await a.acquire()
    expect(res.acquired).toBe(false)
    expect(res.reason).toBe('db-error')
  })
})

describe('LeasedHorizonListener', () => {
  let store: InMemoryLeaseStore

  beforeEach(() => {
    store = createInMemoryLeaseStore()
  })

  it('processes events while it holds the lease and advances the cursor', async () => {
    const led = new LeasedHorizonListener(
      new LeaseManager(store, {
        streamName: STREAM, ownerId: 'a', ttlMs: 1_000, heartbeatMs: 100,
      }),
      { inner: noopListener() },
    )
    expect((await led.start()).acquired).toBe(true)
    expect(await led.process(mkEvent('10'))).toBe('processed')
    expect(await led.process(mkEvent('20'))).toBe('processed')
    expect((await led.lease.peek())?.pagingToken).toBe('20')
  })

  it('returns "skipped" when the lease has been stolen', async () => {
    const a = new LeasedHorizonListener(
      new LeaseManager(store, {
        streamName: STREAM, ownerId: 'a', ttlMs: 500, heartbeatMs: 100,
      }),
      { inner: noopListener() },
    )
    const b = new LeasedHorizonListener(
      new LeaseManager(store, {
        streamName: STREAM, ownerId: 'b', ttlMs: 500, heartbeatMs: 100,
      }),
      { inner: noopListener() },
    )
    await a.start()
    store.expireLease(STREAM)
    await b.start()

    expect(await a.process(mkEvent('99'))).toBe('skipped')
  })

  it('stop() releases the lease so a standby can take over', async () => {
    const a = new LeasedHorizonListener(
      new LeaseManager(store, {
        streamName: STREAM, ownerId: 'a', ttlMs: 5_000, heartbeatMs: 100,
      }),
      { inner: noopListener() },
    )
    const b = new LeasedHorizonListener(
      new LeaseManager(store, {
        streamName: STREAM, ownerId: 'b', ttlMs: 5_000, heartbeatMs: 100,
      }),
      { inner: noopListener() },
    )
    await a.start()
    expect((await b.start()).acquired).toBe(false)
    await a.stop()
    expect((await b.start()).acquired).toBe(true)
  })

  it('uses default HorizonListener when no inner is provided', () => {
    const led = new LeasedHorizonListener(
      new LeaseManager(store, {
        streamName: STREAM, ownerId: 'a', ttlMs: 1_000, heartbeatMs: 100,
      }),
    )
    expect(led.inner).toBeInstanceOf(HorizonListener)
  })
})
