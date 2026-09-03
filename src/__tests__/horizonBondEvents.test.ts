import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DlqRouter, type DlqSink } from '../listeners/messageValidator.js'

const streamState = vi.hoisted(() => ({
  onmessage: undefined as undefined | ((op: any) => Promise<void>),
}))

const mocks = vi.hoisted(() => {
  const mockClientQuery = vi.fn()
  const mockClientRelease = vi.fn()
  const mockClient = { query: mockClientQuery, release: mockClientRelease }
  const mockPoolConnect = vi.fn().mockResolvedValue(mockClient)
  const mockPoolQuery = vi.fn().mockResolvedValue({ rows: [] })
  return { mockClientQuery, mockClientRelease, mockClient, mockPoolConnect, mockPoolQuery }
})

vi.mock('@stellar/stellar-sdk', () => {
  class ServerMock {
    operations() {
      return {
        forAsset: () => ({
          cursor: () => ({
            stream: ({ onmessage }: { onmessage: (op: any) => Promise<void> }) => {
              streamState.onmessage = onmessage
            },
          }),
        }),
      }
    }
  }

  return {
    Horizon: { Server: ServerMock },
    StrKey: {
      isValidEd25519PublicKey: (account: string) => typeof account === 'string' && account.startsWith('G'),
      isValidMuxedAccount: () => false,
    },
  }
})

vi.mock('../db/pool', () => ({
  pool: { connect: mocks.mockPoolConnect, query: mocks.mockPoolQuery },
}))

vi.mock('../services/identityService', () => ({
  upsertIdentity: vi.fn().mockResolvedValue(undefined),
  upsertBond: vi.fn().mockResolvedValue(undefined),
  upsertCursor: vi.fn().mockResolvedValue(undefined),
  upsertCursorMonotonic: vi.fn().mockResolvedValue(null),
}))

import { subscribeBondCreationEvents } from '../listeners/horizonBondEvents.js'
import { upsertBond, upsertIdentity, upsertCursorMonotonic } from '../services/identityService.js'

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => resolve(undefined))
}

function makeRouter(): DlqRouter {
  const sink: DlqSink = { async captureFailure() {} }
  return new DlqRouter(sink)
}

describe('Horizon Bond Creation Listener', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamState.onmessage = undefined
    mocks.mockClientQuery.mockReset()
    mocks.mockClientRelease.mockReset()
    mocks.mockPoolConnect.mockReset()
    mocks.mockPoolQuery.mockReset()
    mocks.mockPoolConnect.mockResolvedValue(mocks.mockClient)
    mocks.mockPoolQuery.mockResolvedValue({ rows: [] })
  })

  it('subscribes without throwing', () => {
    expect(() => subscribeBondCreationEvents(makeRouter())).not.toThrow()
    expect(streamState.onmessage).toBeTypeOf('function')
  })

  it('accepts an undefined callback', () => {
    expect(() => subscribeBondCreationEvents(makeRouter(), undefined)).not.toThrow()
    expect(streamState.onmessage).toBeTypeOf('function')
  })

  it('parses and upserts create_bond events', async () => {
    const onEvent = vi.fn()
    subscribeBondCreationEvents(makeRouter(), onEvent)

    await streamState.onmessage!({
      type: 'create_bond',
      source_account: 'GABC...',
      id: 'bond123',
      amount: '1000',
      duration: '365',
      paging_token: 'token1',
    })

    expect(upsertIdentity).toHaveBeenCalledWith({ id: 'GABC...' }, mocks.mockClient)
    expect(upsertBond).toHaveBeenCalledWith({ id: 'bond123', address: 'GABC...', amount: '1000', duration: '365' }, mocks.mockClient)
    expect(upsertCursorMonotonic).toHaveBeenCalledWith(
      { streamName: 'bond_creation', pagingToken: 'token1' },
      mocks.mockClient
    )
    expect(mocks.mockClientQuery).toHaveBeenCalledWith('BEGIN')
    expect(mocks.mockClientQuery).toHaveBeenCalledWith('COMMIT')
    expect(mocks.mockClientRelease).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith({
      identity: { id: 'GABC...' },
      bond: { id: 'bond123', address: 'GABC...', amount: '1000', duration: '365' },
    })
  })

  it('ignores non-bond events', async () => {
    const onEvent = vi.fn()
    subscribeBondCreationEvents(makeRouter(), onEvent)

    await streamState.onmessage!({
      type: 'payment',
      id: 'other',
      paging_token: 'token2',
    })

    expect(upsertIdentity).not.toHaveBeenCalled()
    expect(upsertBond).not.toHaveBeenCalled()
    expect(upsertCursorMonotonic).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('handles duplicate create_bond events consistently (each delivery is committed atomically)', async () => {
    // Note: duplicate *detection* happens at the ledger boundary (UNIQUE
    // (stream, event_id) + payload fingerprint) which a stateless mock pool
    // cannot emulate. This test proves each delivery is processed atomically
    // without erroring; the real no-second-effect guarantee is covered by the
    // pg-mem ingestion boundary tests in
    // src/listeners/__tests__/horizonBondEvents.replay.test.ts.
    subscribeBondCreationEvents(makeRouter(), vi.fn())

    const event = {
      type: 'create_bond',
      source_account: 'GABC...',
      id: 'bond123',
      amount: '1000',
      duration: '365',
      paging_token: 'token1',
    }

    await streamState.onmessage!(event)
    await streamState.onmessage!(event)

    expect(upsertIdentity).toHaveBeenCalledTimes(2)
    expect(upsertBond).toHaveBeenCalledTimes(2)
    expect(upsertCursorMonotonic).toHaveBeenCalledTimes(2)
  })

  it('rolls back transaction on failure and does not advance cursor', async () => {
    const error = new Error('DB error')
    upsertIdentity.mockRejectedValueOnce(error)

    const onEvent = vi.fn()
    subscribeBondCreationEvents({ captureFailure: vi.fn() }, onEvent)
    await flushMicrotasks()

    await expect(streamState.onmessage!({
      type: 'create_bond',
      source_account: 'GABC...',
      id: 'bond123',
      amount: '1000',
      duration: '365',
      paging_token: 'token1',
    })).rejects.toThrow('DB error')

    expect(mocks.mockClientQuery).toHaveBeenCalledWith('ROLLBACK')
    expect(mocks.mockClientRelease).toHaveBeenCalledOnce()
    expect(upsertCursorMonotonic).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
  })
})
