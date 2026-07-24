import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import { fetch } from 'node:undici'
import { Pool } from 'pg'
import { createHorizonWithdrawalListener } from '../../src/listeners/horizonWithdrawalEvents.js'
import {
  dockerComposeUp,
  dockerComposeDown,
  dockerComposePause,
  dockerComposeUnpause,
  waitForCondition,
  waitForDbConnection,
  waitForUrl,
} from './chaosHelpers.js'

vi.setTimeout(120000)

describe('Horizon listener recovery chaos', () => {
  const dbUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://credence:credence@localhost:5433/credence_test'
  const horizonUrl = process.env.TEST_HORIZON_URL ?? 'http://localhost:8000'
  let pool: Pool
  let listener: ReturnType<typeof createHorizonWithdrawalListener>

  beforeAll(async () => {
    process.env.DB_URL = dbUrl
    process.env.HORIZON_URL = horizonUrl
    process.env.NODE_ENV = 'test'

    await dockerComposeUp()
    await waitForDbConnection(dbUrl)
    await waitForUrl(`${horizonUrl}/health`)

    pool = new Pool({ connectionString: dbUrl })
    await pool.query(`
      CREATE TABLE IF NOT EXISTS horizon_cursors (
        stream_name TEXT PRIMARY KEY,
        paging_token TEXT NOT NULL,
        last_checkpoint TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    listener = createHorizonWithdrawalListener({ horizonUrl, pollingInterval: 1000 }, pool, {
      captureFailure: async () => ({})
    })

    await listener.start()
    await waitForCondition(async () => {
      if (!listener.isActive()) {
        throw new Error('Listener has not started')
      }
      return true
    }, 10000)
  })

  afterAll(async () => {
    await listener.stop().catch(() => {})
    await pool.end().catch(() => {})
    await dockerComposeDown()
  })

  it('recovers from a Horizon stall and resumes polling after restart', async () => {
    const firstEvent = {
      id: '1',
      paging_token: '1000',
      type: 'payment',
      created_at: '2024-01-01T00:00:00Z',
      transaction_hash: 'txhash-1',
      source_account: 'GABCDEF1234567890ABCDEF1234567890ABCDEF',
      amount: '10',
      asset_type: 'native',
    }

    await fetch(`${horizonUrl}/__test/add-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firstEvent),
    })

    await waitForCondition(async () => {
      if (listener.getCursor() !== '1000') {
        throw new Error(`Expected cursor 1000, got ${listener.getCursor()}`)
      }
      return true
    }, 20000)

    await dockerComposePause('test-horizon')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await dockerComposeUnpause('test-horizon')

    const secondEvent = {
      id: '2',
      paging_token: '2000',
      type: 'payment',
      created_at: '2024-01-01T00:00:01Z',
      transaction_hash: 'txhash-2',
      source_account: 'GABCDEF1234567890ABCDEF1234567890ABCDEF',
      amount: '15',
      asset_type: 'native',
    }

    await fetch(`${horizonUrl}/__test/add-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secondEvent),
    })

    await waitForCondition(async () => {
      if (listener.getCursor() !== '2000') {
        throw new Error(`Expected cursor 2000, got ${listener.getCursor()}`)
      }
      return true
    }, 20000)

    expect(listener.isActive()).toBe(true)
  })
})
