import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { createSchema, resetDatabase } from '../../src/db/schema.js'
import { TransactionManager } from '../../src/db/transaction.js'

let db: TestDatabase
let txManager: TransactionManager

class ServiceC {
  constructor(
    private readonly pool: Pool,
    private readonly tx: TransactionManager
  ) {}

  async execute(address: string, fail = false) {
    return await this.tx.withTransaction(async () => {
      await this.pool.query(
        `INSERT INTO identities (address, display_name) VALUES ($1, $2)`,
        [address, 'ServiceC']
      )
      if (fail) {
        throw new Error('ServiceC failed!')
      }
    })
  }
}

class ServiceB {
  constructor(
    private readonly pool: Pool,
    private readonly tx: TransactionManager,
    private readonly serviceC: ServiceC
  ) {}

  async execute(addressB: string, addressC: string, failC = false, failB = false) {
    return await this.tx.withTransaction(async () => {
      await this.pool.query(
        `INSERT INTO identities (address, display_name) VALUES ($1, $2)`,
        [addressB, 'ServiceB']
      )
      
      await this.serviceC.execute(addressC, failC)

      if (failB) {
        throw new Error('ServiceB failed!')
      }
    })
  }
}

class ServiceA {
  constructor(
    private readonly pool: Pool,
    private readonly tx: TransactionManager,
    private readonly serviceB: ServiceB
  ) {}

  async execute(addressA: string, addressB: string, addressC: string, options: { failC?: boolean, failB?: boolean, failA?: boolean } = {}) {
    return await this.tx.withTransaction(async () => {
      await this.pool.query(
        `INSERT INTO identities (address, display_name) VALUES ($1, $2)`,
        [addressA, 'ServiceA']
      )

      await this.serviceB.execute(addressB, addressC, options.failC, options.failB)

      if (options.failA) {
        throw new Error('ServiceA failed!')
      }
    })
  }
}

describe('Nested Transactions Integration', () => {
  beforeAll(async () => {
    db = await createTestDatabase()

    if (db.connectionString.startsWith('pg-mem://')) {
      const { newDb } = await import('pg-mem')
      const pgm = newDb()
      const adapter = pgm.adapters.createPg()
      const mockPool = new adapter.Pool()

      const originalConnect = mockPool.connect.bind(mockPool)
      mockPool.connect = async function() {
        const client = await originalConnect()
        let backup: any = null
        
        const originalClientQuery = client.query.bind(client)
        client.query = async function(text: any, values: any) {
          const sql = typeof text === 'string' ? text : text?.text
          if (sql === 'BEGIN' || (sql && sql.startsWith('BEGIN'))) {
            backup = pgm.backup()
          } else if (sql === 'ROLLBACK') {
            if (backup) {
              backup.restore()
            }
          } else if (sql === 'COMMIT') {
            backup = null
          }
          return await originalClientQuery(text, values)
        }
        return client
      }

      db.pool = mockPool

      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS identities (
          address TEXT PRIMARY KEY,
          display_name TEXT
        )
      `)
    } else {
      await createSchema(db.pool)
    }

    txManager = new TransactionManager(db.pool)
  }, 120000)

  afterAll(async () => {
    if (db) {
      await db.close()
    }
  })

  beforeEach(async () => {
    if (db.connectionString.startsWith('pg-mem://')) {
      await db.pool.query('DELETE FROM identities')
    } else {
      await resetDatabase(db.pool)
    }
  })

  it('commits all database changes when successful', async () => {
    const serviceC = new ServiceC(db.pool, txManager)
    const serviceB = new ServiceB(db.pool, txManager, serviceC)
    const serviceA = new ServiceA(db.pool, txManager, serviceB)

    await serviceA.execute('addr_a1', 'addr_b1', 'addr_c1')

    const result = await db.pool.query('SELECT * FROM identities ORDER BY address')
    expect(result.rows).toHaveLength(3)
    expect(result.rows.map(r => r.address)).toEqual(['addr_a1', 'addr_b1', 'addr_c1'])
  })

  it('rolls back all database changes when inner service C fails', async () => {
    const serviceC = new ServiceC(db.pool, txManager)
    const serviceB = new ServiceB(db.pool, txManager, serviceC)
    const serviceA = new ServiceA(db.pool, txManager, serviceB)

    await expect(
      serviceA.execute('addr_a2', 'addr_b2', 'addr_c2', { failC: true })
    ).rejects.toThrow('ServiceC failed!')

    const result = await db.pool.query('SELECT * FROM identities')
    expect(result.rows).toHaveLength(0)
  })

  it('rolls back all database changes when middle service B fails', async () => {
    const serviceC = new ServiceC(db.pool, txManager)
    const serviceB = new ServiceB(db.pool, txManager, serviceC)
    const serviceA = new ServiceA(db.pool, txManager, serviceB)

    await expect(
      serviceA.execute('addr_a3', 'addr_b3', 'addr_c3', { failB: true })
    ).rejects.toThrow('ServiceB failed!')

    const result = await db.pool.query('SELECT * FROM identities')
    expect(result.rows).toHaveLength(0)
  })

  it('rolls back all database changes when outer service A fails', async () => {
    const serviceC = new ServiceC(db.pool, txManager)
    const serviceB = new ServiceB(db.pool, txManager, serviceC)
    const serviceA = new ServiceA(db.pool, txManager, serviceB)

    await expect(
      serviceA.execute('addr_a4', 'addr_b4', 'addr_c4', { failA: true })
    ).rejects.toThrow('ServiceA failed!')

    const result = await db.pool.query('SELECT * FROM identities')
    expect(result.rows).toHaveLength(0)
  })
})
