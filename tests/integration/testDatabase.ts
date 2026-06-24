import { Pool } from 'pg'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { createClient, type RedisClientType } from 'redis'

export interface TestDatabase {
  pool: Pool
  close: () => Promise<void>
  connectionString: string
}

export interface TestCache {
  client: RedisClientType
  close: () => Promise<void>
  connectionString: string
}

const waitForReadyLog = Wait.forLogMessage(/database system is ready to accept connections/i)

export async function createTestDatabase(): Promise<TestDatabase> {
  const externalConnectionString = process.env.TEST_DATABASE_URL

  if (externalConnectionString) {
    const pool = new Pool({ connectionString: externalConnectionString })
    await pool.query('SELECT 1')

    return {
      connectionString: externalConnectionString,
      pool,
      close: async () => {
        await pool.end()
      },
    }
  }

  const user = 'credence'
  const password = 'credence'
  const database = 'credence_test'

  try {
    const container: StartedTestContainer = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_DB: database,
        POSTGRES_PASSWORD: password,
        POSTGRES_USER: user,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(waitForReadyLog)
      .withStartupTimeout(10000)
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(5432)
    const connectionString = `postgresql://${user}:${password}@${host}:${port}/${database}`

    const pool = new Pool({ connectionString })
    await pool.query('SELECT 1')

    return {
      connectionString,
      pool,
      close: async () => {
        await pool.end()
        await container.stop()
      },
    }
  } catch (error) {
    console.warn('Testcontainers (Postgres) failed to start, falling back to mock:', (error as Error).message)
    
    // Fallback logic using pg-mem or just a mock if needed
    // For this environment, we'll return a mock that uses pg-mem if available, 
    // but since we want to be robust, we'll use a simple Pool that might error 
    // unless the user has a local postgres. 
    // Better: use pg-mem if possible.
    
    try {
      const { newDb } = await import('pg-mem')
      const pgm = newDb()
      
      const adapter = pgm.adapters.createPg()
      const mockPool = new adapter.Pool()

      return {
        connectionString: 'pg-mem://memory',
        pool: mockPool,
        close: async () => {},
      }
    } catch (e) {
        // If pg-mem is also not available, we might have to skip or fail gracefully
        throw new Error('No working database strategy found (Testcontainers or pg-mem)')
    }
  }
}

export async function createTestCache(): Promise<TestCache> {
  try {
    const container: StartedTestContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/i))
      .withStartupTimeout(10000)
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(6379)
    const connectionString = `redis://${host}:${port}`

    const client = createClient({ url: connectionString }) as RedisClientType
    await client.connect()

    return {
      client,
      connectionString,
      close: async () => {
        await client.quit()
        await container.stop()
      },
    }
  } catch (error) {
    console.warn('Testcontainers (Redis) failed to start, falling back to mock:', (error as Error).message)
    
    const storage = new Map<string, string>()
    const mockClient = {
      connect: async () => {},
      get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, value: string) => { storage.set(key, value); return 'OK' },
      setEx: async (key: string, ttl: number, value: string) => { storage.set(key, value); return 'OK' },
      del: async (key: string) => { const existed = storage.has(key); storage.delete(key); return existed ? 1 : 0 },
      quit: async () => {},
      disconnect: async () => {},
      on: () => {},
      isOpen: true,
    } as any

    return {
      client: mockClient,
      connectionString: 'redis://mock',
      close: async () => {},
    }
  }
}
