import { describe, expect, it } from 'vitest'
import { waitForInFlight } from '../idempotency.js'

describe('idempotency in-flight barrier', () => {
  it('lets the first request acquire immediately', async () => {
    const release = await waitForInFlight('first-request')
    let secondAcquired = false
    const second = waitForInFlight('first-request').then((unlock) => {
      secondAcquired = true
      unlock()
    })

    await Promise.resolve()
    expect(secondAcquired).toBe(false)
    release()
    await second
    expect(secondAcquired).toBe(true)
  })

  it('serializes a queue of retries in arrival order', async () => {
    const first = await waitForInFlight('queued-request')
    const order: number[] = []
    const second = waitForInFlight('queued-request').then((release) => {
      order.push(2)
      release()
    })
    const third = waitForInFlight('queued-request').then((release) => {
      order.push(3)
      release()
    })

    await Promise.resolve()
    expect(order).toEqual([])
    first()
    await second
    await third
    expect(order).toEqual([2, 3])
  })

  it('does not block different idempotency keys', async () => {
    const first = await waitForInFlight('key-a')
    const second = await waitForInFlight('key-b')
    let aFinished = false
    let bFinished = false
    const waitingA = waitForInFlight('key-a').then((release) => {
      aFinished = true
      release()
    })
    const waitingB = waitForInFlight('key-b').then((release) => {
      bFinished = true
      release()
    })

    await Promise.resolve()
    expect(aFinished).toBe(false)
    expect(bFinished).toBe(false)
    first()
    await waitingA
    expect(aFinished).toBe(true)
    expect(bFinished).toBe(false)
    second()
    await waitingB
    expect(bFinished).toBe(true)
  })

  it('release is idempotent and does not unlock a later owner', async () => {
    const first = await waitForInFlight('release-key')
    const waiting = waitForInFlight('release-key')
    first()
    first()
    const second = await waiting
    let thirdAcquired = false
    const third = waitForInFlight('release-key').then((release) => {
      thirdAcquired = true
      release()
    })

    await Promise.resolve()
    expect(thirdAcquired).toBe(false)
    second()
    await third
    expect(thirdAcquired).toBe(true)
  })

  it('allows a failed request to release its slot for recovery', async () => {
    const release = await waitForInFlight('failure-key')
    const retry = waitForInFlight('failure-key')
    release()
    const retryRelease = await retry
    expect(typeof retryRelease).toBe('function')
    retryRelease()
  })
})
