import { Pool } from 'pg'
import { BondsRepository, InsufficientFundsError } from './bondsRepository.js'
import { LockTimeoutError } from '../transaction.js'
import { IdentitiesRepository } from './identitiesRepository.js'

describe('BondsRepository - Lock Timeout', () => {
  let pool: Pool
  let bondsRepo: BondsRepository
  let identitiesRepo: IdentitiesRepository
  let testIdentityAddress: string

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DB_URL,
      max: 10,
    })

    // Create repositories with short timeouts for testing
    bondsRepo = new BondsRepository(pool, pool, {
      readonly: 500,
      default: 1000,
      critical: 2000,
    })
    identitiesRepo = new IdentitiesRepository(pool)

    // Setup test identity
    const identity = await identitiesRepo.create({
      address: `test-${Date.now()}`,
    })
    testIdentityAddress = identity.address
  })

  afterAll(async () => {
    await pool.end()
  })

  describe('debit with lock timeout', () => {
    it('should successfully debit when no contention', async () => {
      const bond = await bondsRepo.create({
        identityAddress: testIdentityAddress,
        amount: '1000',
        startTime: new Date(),
        durationDays: 30,
      })

      const updated = await bondsRepo.debit(bond.id, '100')

      expect(updated.amount).toBe('900')
    })

    it('should throw InsufficientFundsError when amount exceeds balance', async () => {
      const bond = await bondsRepo.create({
        identityAddress: testIdentityAddress,
        amount: '500',
        startTime: new Date(),
        durationDays: 30,
      })

      await expect(bondsRepo.debit(bond.id, '600')).rejects.toThrow(
        InsufficientFundsError
      )
    })

    it('should handle concurrent debits with retry', async () => {
      const bond = await bondsRepo.create({
        identityAddress: testIdentityAddress,
        amount: '1000',
        startTime: new Date(),
        durationDays: 30,
      })

      // Execute concurrent debits
      const results = await Promise.all([
        bondsRepo.debit(bond.id, '100'),
        bondsRepo.debit(bond.id, '200'),
        bondsRepo.debit(bond.id, '150'),
      ])

      // All debits should succeed
      expect(results).toHaveLength(3)

      // Final balance should be 1000 - 100 - 200 - 150 = 550
      const final = await bondsRepo.findById(bond.id)
      expect(final?.amount).toBe('550')
    })

    it('should retry on lock timeout and eventually succeed', async () => {
      const bond = await bondsRepo.create({
        identityAddress: testIdentityAddress,
        amount: '1000',
        startTime: new Date(),
        durationDays: 30,
      })

      // Hold a lock briefly
      const client = await pool.connect()
      await client.query('BEGIN')
      await client.query('SELECT * FROM bonds WHERE id = $1 FOR UPDATE', [bond.id])

      // Release after 500ms
      setTimeout(async () => {
        await client.query('ROLLBACK')
        client.release()
      }, 500)

      // This should retry and succeed after lock is released
      const updated = await bondsRepo.debit(bond.id, '100')
      expect(updated.amount).toBe('900')
    })

    it('should throw LockTimeoutError after max retries', async () => {
      const bond = await bondsRepo.create({
        identityAddress: testIdentityAddress,
        amount: '1000',
        startTime: new Date(),
        durationDays: 30,
      })

      // Hold lock for longer than retry window
      const client = await pool.connect()
      await client.query('BEGIN')
      await client.query('SELECT * FROM bonds WHERE id = $1 FOR UPDATE', [bond.id])

      try {
        // Create repo with very short timeout
        const shortTimeoutRepo = new BondsRepository(pool, pool, {
          readonly: 100,
          default: 100,
          critical: 200,
        })

        await expect(shortTimeoutRepo.debit(bond.id, '100')).rejects.toThrow(
          LockTimeoutError
        )
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })

    it('should serialize multiple concurrent debits correctly', async () => {
      const bond = await bondsRepo.create({
        identityAddress: testIdentityAddress,
        amount: '10000',
        startTime: new Date(),
        durationDays: 30,
      })

      // Execute many concurrent debits
      const debitPromises = Array.from({ length: 10 }, (_, i) =>
        bondsRepo.debit(bond.id, '100')
      )

      await Promise.all(debitPromises)

      // Final balance should be 10000 - (10 * 100) = 9000
      const final = await bondsRepo.findById(bond.id)
      expect(final?.amount).toBe('9000')
    })

    it('should handle mixed success and insufficient funds', async () => {
      const bond = await bondsRepo.create({
        identityAddress: testIdentityAddress,
        amount: '500',
        startTime: new Date(),
        durationDays: 30,
      })

      const results = await Promise.allSettled([
        bondsRepo.debit(bond.id, '200'),
        bondsRepo.debit(bond.id, '200'),
        bondsRepo.debit(bond.id, '200'), // This should fail
      ])

      const succeeded = results.filter((r) => r.status === 'fulfilled')
      const failed = results.filter((r) => r.status === 'rejected')

      expect(succeeded.length).toBe(2)
      expect(failed.length).toBe(1)

      // Check that the failure is InsufficientFundsError
      const failedResult = failed[0] as PromiseRejectedResult
      expect(failedResult.reason).toBeInstanceOf(InsufficientFundsError)
    })
  })

  describe('error metadata', () => {
    it('should include policy and timeout in LockTimeoutError', async () => {
      const bond = await bondsRepo.create({
        identityAddress: testIdentityAddress,
        amount: '1000',
        startTime: new Date(),
        durationDays: 30,
      })

      const client = await pool.connect()
      await client.query('BEGIN')
      await client.query('SELECT * FROM bonds WHERE id = $1 FOR UPDATE', [bond.id])

      try {
        const shortTimeoutRepo = new BondsRepository(pool, pool, {
          readonly: 100,
          default: 100,
          critical: 100,
        })

        await shortTimeoutRepo.debit(bond.id, '100')
      } catch (error) {
        expect(error).toBeInstanceOf(LockTimeoutError)
        const lockError = error as LockTimeoutError
        expect(lockError.policy).toBe('critical')
        expect(lockError.timeoutMs).toBe(100)
        expect(lockError.message).toContain('Lock timeout')
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })
  })
})
