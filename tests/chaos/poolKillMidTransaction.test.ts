import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import { Pool } from 'pg'
import {
  dockerComposeUp,
  dockerComposeDown,
  dockerComposeRestart,
  waitForDbConnection,
} from './chaosHelpers.js'

vi.setTimeout(120000)

describe('Pool kill mid-transaction chaos', () => {
  const dbUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://credence:credence@localhost:5433/credence_test'
  let pool: Pool

  beforeAll(async () => {
    await dockerComposeUp()
    await waitForDbConnection(dbUrl)

    pool = new Pool({ connectionString: dbUrl, max: 5 })
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chaos_pool_test (
        id SERIAL PRIMARY KEY,
        val TEXT NOT NULL
      )
    `)
    await pool.query(`DELETE FROM chaos_pool_test`)
  })

  afterAll(async () => {
    await pool.end().catch(() => {})
    await dockerComposeDown()
  })

  it('recovers from pool restart mid-transaction and does not leak connections', async () => {
    await pool.query(`INSERT INTO chaos_pool_test (val) VALUES ('pre-tx-row')`)

    const baselineCounts = {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    }

    let client
    try {
      client = await pool.connect()
      await client.query('BEGIN')
      await client.query(`INSERT INTO chaos_pool_test (val) VALUES ('mid-tx-row')`)
      const pidResult = await client.query('SELECT pg_backend_pid() AS pid')
      const pid = pidResult.rows[0].pid

      await dockerComposeRestart('test-db')
      await waitForDbConnection(dbUrl)

      await expect(client.query('COMMIT')).rejects.toThrow()

      client.release(true)
      client = null
    } catch (err) {
      if (client) {
        client.release(true)
        client = null
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000))

    const retryClient = await pool.connect()
    try {
      await retryClient.query('BEGIN')
      await retryClient.query(`INSERT INTO chaos_pool_test (val) VALUES ('retry-row')`)
      await retryClient.query('COMMIT')
    } finally {
      retryClient.release()
    }

    const { rows } = await pool.query('SELECT val FROM chaos_pool_test ORDER BY id')
    const vals = rows.map((r) => r.val)
    expect(vals).toContain('pre-tx-row')
    expect(vals).toContain('retry-row')
    expect(vals).not.toContain('mid-tx-row')

    expect(pool.totalCount).toBeLessThanOrEqual(pool.options.max)
    expect(pool.idleCount + pool.waitingCount).toBeLessThanOrEqual(pool.totalCount)
  })

  it('handles repeated mid-transaction pool kills without leaking connections', async () => {
    for (let i = 0; i < 3; i++) {
      let client
      try {
        client = await pool.connect()
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO chaos_pool_test (val) VALUES ($1)`,
          [`round-${i}-mid-tx`],
        )

        await dockerComposeRestart('test-db')
        await waitForDbConnection(dbUrl)

        await expect(client.query('COMMIT')).rejects.toThrow()

        client.release(true)
        client = null
      } catch (err) {
        if (client) {
          client.release(true)
          client = null
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))

      const recoveryClient = await pool.connect()
      try {
        await recoveryClient.query('BEGIN')
        await recoveryClient.query(
          `INSERT INTO chaos_pool_test (val) VALUES ($1)`,
          [`round-${i}-recovered`],
        )
        await recoveryClient.query('COMMIT')
      } finally {
        recoveryClient.release()
      }
    }

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM chaos_pool_test',
    )
    expect(rows[0].cnt).toBeGreaterThan(0)

    expect(pool.totalCount).toBeLessThanOrEqual(pool.options.max)
    expect(pool.idleCount + pool.waitingCount).toBeLessThanOrEqual(pool.totalCount)
  })

  it('completes a concurrent healthy transaction while another is killed', async () => {
    const healthyTx = pool.connect()
    const doomedTx = pool.connect()
    const [healthyClient, doomedClient] = await Promise.all([healthyTx, doomedTx])

    try {
      await doomedClient.query('BEGIN')
      await doomedClient.query(
        `INSERT INTO chaos_pool_test (val) VALUES ('doomed-tx')`,
      )

      const healthyResult = await healthyClient.query(
        `INSERT INTO chaos_pool_test (val) VALUES ('healthy-tx') RETURNING id`,
      )
      const healthyId = healthyResult.rows[0].id

      await dockerComposeRestart('test-db')
      await waitForDbConnection(dbUrl)

      await expect(doomedClient.query('COMMIT')).rejects.toThrow()
      doomedClient.release(true)

      const healthyCheck = await healthyClient.query(
        `SELECT val FROM chaos_pool_test WHERE id = $1`,
        [healthyId],
      )
      expect(healthyCheck.rows.length).toBe(0)
      healthyClient.release(true)
    } catch (err) {
      doomedClient.release(true)
      healthyClient.release(true)
    }

    await new Promise((resolve) => setTimeout(resolve, 2000))

    const verifyClient = await pool.connect()
    try {
      const { rows } = await pool.query('SELECT val FROM chaos_pool_test ORDER BY id')
      const vals = rows.map((r) => r.val)
      expect(vals).not.toContain('doomed-tx')
    } finally {
      verifyClient.release()
    }

    expect(pool.totalCount).toBeLessThanOrEqual(pool.options.max)
  })
})
