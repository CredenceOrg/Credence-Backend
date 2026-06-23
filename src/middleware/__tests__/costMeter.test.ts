import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgresContainer } from 'testcontainers'
import { Pool } from 'pg'
import {
  deductCredits,
  refundCredits,
  resolveCostWeight,
  initializeCreditTable,
  configureCostMeter,
  setDbPool,
} from '../costMeter.js'

let container: PostgresContainer
let pool: Pool

beforeAll(async () => {
  container = await new PostgresContainer().start()

  pool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
  })

  setDbPool(pool)
  await initializeCreditTable()
})

afterAll(async () => {
  await pool.end()
  await container.stop()
})

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE org_credits')
  configureCostMeter({ defaultCostWeight: 1, costWeights: {}, maxRetries: 3 })
})

describe('costMeter middleware', () => {
  describe('deductCredits', () => {
    it('deducts credits from an org', async () => {
      await deductCredits('org-1', 100)

      const result = await pool.query('SELECT balance FROM org_credits WHERE org_id = $1', ['org-1'])
      expect(result.rows[0].balance).toBe(10000 - 100)
    })

    it('initializes credits on first deduction if not present', async () => {
      await deductCredits('org-new', 50)

      const result = await pool.query('SELECT balance FROM org_credits WHERE org_id = $1', ['org-new'])
      expect(result.rows[0].balance).toBe(10000 - 50)
    })

    it('throws insufficient credits error', async () => {
      await deductCredits('org-2', 9999)

      await expect(deductCredits('org-2', 2)).rejects.toThrow('Insufficient credits')
    })

    it('handles concurrent deductions with optimistic locking retries', async () => {
      await deductCredits('org-concurrent', 0)

      const costs = [100, 200, 150, 75]
      const promises = costs.map((cost) => deductCredits('org-concurrent', cost))

      await Promise.all(promises)

      const result = await pool.query(
        'SELECT balance FROM org_credits WHERE org_id = $1',
        ['org-concurrent'],
      )
      const expectedBalance = 10000 - costs.reduce((a, b) => a + b, 0)
      expect(result.rows[0].balance).toBe(expectedBalance)
    })

    it('maintains correct version after concurrent deductions', async () => {
      await deductCredits('org-version', 0)

      const costs = [100, 200, 150]
      await Promise.all(costs.map((cost) => deductCredits('org-version', cost)))

      const result = await pool.query(
        'SELECT version FROM org_credits WHERE org_id = $1',
        ['org-version'],
      )
      expect(result.rows[0].version).toBe(3)
    })

    it('rejects negative or zero costs', async () => {
      await expect(deductCredits('org-3', 0)).rejects.toThrow('Cost must be positive')
      await expect(deductCredits('org-3', -100)).rejects.toThrow('Cost must be positive')
    })

    it('respects max retries for version conflicts', async () => {
      configureCostMeter({ maxRetries: 1 })

      await pool.query('INSERT INTO org_credits (org_id, balance, version) VALUES ($1, $2, $3)', [
        'org-retry',
        10000,
        1,
      ])

      const conflict1 = deductCredits('org-retry', 100, 1)
      const conflict2 = deductCredits('org-retry', 100, 1)

      const results = await Promise.allSettled([conflict1, conflict2])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      expect(rejected.length).toBeGreaterThan(0)
    })
  })

  describe('refundCredits', () => {
    it('refunds credits to an org', async () => {
      await deductCredits('org-4', 500)
      await refundCredits('org-4', 200)

      const result = await pool.query('SELECT balance FROM org_credits WHERE org_id = $1', ['org-4'])
      expect(result.rows[0].balance).toBe(10000 - 500 + 200)
    })

    it('increments version on refund', async () => {
      await deductCredits('org-5', 100)
      const beforeRefund = await pool.query(
        'SELECT version FROM org_credits WHERE org_id = $1',
        ['org-5'],
      )

      await refundCredits('org-5', 50)

      const afterRefund = await pool.query(
        'SELECT version FROM org_credits WHERE org_id = $1',
        ['org-5'],
      )
      expect(afterRefund.rows[0].version).toBe(beforeRefund.rows[0].version + 1)
    })

    it('silently skips refund if org does not exist', async () => {
      await expect(refundCredits('org-nonexistent', 100)).resolves.not.toThrow()
    })

    it('handles multiple refunds concurrently', async () => {
      await deductCredits('org-6', 0)

      const refunds = [100, 200, 150]
      await Promise.all(refunds.map((amount) => refundCredits('org-6', amount)))

      const result = await pool.query('SELECT balance FROM org_credits WHERE org_id = $1', ['org-6'])
      const expectedBalance = 10000 + refunds.reduce((a, b) => a + b, 0)
      expect(result.rows[0].balance).toBe(expectedBalance)
    })
  })

  describe('resolveCostWeight', () => {
    it('returns configured cost weight for a route', () => {
      configureCostMeter({
        costWeights: {
          '/api/verify': 5,
          '/api/bulk/verify': 10,
        },
      })

      expect(resolveCostWeight('/api/verify')).toBe(5)
      expect(resolveCostWeight('/api/bulk/verify')).toBe(10)
    })

    it('returns default cost weight for unconfigured routes', () => {
      configureCostMeter({ defaultCostWeight: 2, costWeights: {} })

      expect(resolveCostWeight('/api/unknown')).toBe(2)
    })

    it('returns default (1) when no configuration is set', () => {
      configureCostMeter({})

      expect(resolveCostWeight('/api/any')).toBe(1)
    })
  })

  describe('credit initialization race', () => {
    it('resolves multiple simultaneous first-time requests to single correct balance', async () => {
      const costs = [100, 100, 100]

      const promises = costs.map(() => deductCredits('org-race', 100))
      await Promise.all(promises)

      const result = await pool.query('SELECT balance FROM org_credits WHERE org_id = $1', [
        'org-race',
      ])
      const expectedBalance = 10000 - costs.reduce((a, b) => a + b, 0)
      expect(result.rows[0].balance).toBe(expectedBalance)
    })
  })

  describe('deduction and refund interaction', () => {
    it('correctly tracks balance through deductions and refunds', async () => {
      const orgId = 'org-interaction'

      await deductCredits(orgId, 100)
      expect((await getBalance(orgId)).balance).toBe(9900)

      await deductCredits(orgId, 200)
      expect((await getBalance(orgId)).balance).toBe(9700)

      await refundCredits(orgId, 150)
      expect((await getBalance(orgId)).balance).toBe(9850)

      await deductCredits(orgId, 50)
      expect((await getBalance(orgId)).balance).toBe(9800)
    })

    it('maintains version consistency through operations', async () => {
      const orgId = 'org-versions'

      await deductCredits(orgId, 100)
      let version = (await getBalance(orgId)).version
      expect(version).toBe(1)

      await deductCredits(orgId, 50)
      version = (await getBalance(orgId)).version
      expect(version).toBe(2)

      await refundCredits(orgId, 25)
      version = (await getBalance(orgId)).version
      expect(version).toBe(3)
    })
  })
})

async function getBalance(
  orgId: string,
): Promise<{ balance: number; version: number } | null> {
  const result = await pool.query(
    'SELECT balance, version FROM org_credits WHERE org_id = $1',
    [orgId],
  )
  return result.rows[0] || null
}
