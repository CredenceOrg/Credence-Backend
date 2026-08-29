import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Pool } from 'pg'
import { AtomicBondEventProcessor } from '../horizonBondEvents.atomic.js'
import { TransactionManager } from '../../db/transaction.js'

/**
 * Integration tests using real PostgreSQL transaction semantics.
 * These tests verify atomic rollback at the actual integration boundary.
 */
describe('AtomicBondEventProcessor - Integration', () => {
  let pool: Pool
  let processor: AtomicBondEventProcessor

  const testEvent = {
    identity: { id: 'GINTEGRATION123' },
    bond: { 
      id: 'bond-integration-1', 
      address: 'GINTEGRATION123', 
      amount: '500.75', 
      duration: '180' 
    },
    pagingToken: '999999',
    operationId: 'integration-op-1',
  }

  beforeEach(async () => {
    // Use test database - configure via env vars in CI
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/test_db',
    })
    
    // Clean state
    await pool.query('TRUNCATE identities, horizon_cursors, outbox_events, idempotency_keys CASCADE')
    
    processor = new AtomicBondEventProcessor(pool)
  })

  afterEach(async () => {
    await pool.end()
  })

  it('commits all state atomically on success', async () => {
    await processor.process(testEvent)

    // Verify identity exists
    const identity = await pool.query(
      'SELECT * FROM identities WHERE address = $1',
      [testEvent.identity.id]
    )
    expect(identity.rows).toHaveLength(1)
    expect(identity.rows[0].bonded_amount).toBe('500.75')

    // Verify outbox events created
    const outbox = await pool.query(
      'SELECT * FROM outbox_events WHERE aggregate_id = $1',
      [testEvent.bond.id]
    )
    expect(outbox.rows).toHaveLength(2)

    // Verify idempotency marker
    const idempotency = await pool.query(
      'SELECT * FROM idempotency_keys WHERE operation_id = $1',
      [testEvent.operationId]
    )
    expect(idempotency.rows).toHaveLength(1)
  })

  it('rolls back all state if outbox emission fails', async () => {
    // Force outbox failure by dropping table temporarily
    await pool.query('DROP TABLE IF EXISTS outbox_events CASCADE')
    
    await expect(processor.process(testEvent)).rejects.toThrow()

    // Verify no partial identity state
    const identity = await pool.query(
      'SELECT * FROM identities WHERE address = $1',
      [testEvent.identity.id]
    )
    expect(identity.rows).toHaveLength(0)
  })

  it('prevents duplicate processing via idempotency', async () => {
    // Process once
    await processor.process(testEvent)

    // Attempt replay (simulating reorg/gap)
    await processor.process(testEvent)

    // Verify only one bond record
    const bonds = await pool.query(
      'SELECT * FROM identities WHERE address = $1',
      [testEvent.identity.id]
    )
    expect(bonds.rows).toHaveLength(1)

    // Verify only one set of outbox events
    const outbox = await pool.query(
      'SELECT * FROM outbox_events WHERE aggregate_id = $1',
      [testEvent.bond.id]
    )
    expect(outbox.rows).toHaveLength(2) // Still only 2 events, not 4
  })

  it('handles concurrent processing safely', async () => {
    // Simulate concurrent processing of same event
    await Promise.all([
      processor.process(testEvent),
      processor.process(testEvent),
    ])

    // Verify single identity record
    const identities = await pool.query(
      'SELECT * FROM identities WHERE address = $1',
      [testEvent.identity.id]
    )
    expect(identities.rows).toHaveLength(1)

    // Verify single set of outbox events
    const outbox = await pool.query(
      'SELECT * FROM outbox_events WHERE aggregate_id = $1',
      [testEvent.bond.id]
    )
    expect(outbox.rows).toHaveLength(2)
  })
})
