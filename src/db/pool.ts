import { Pool, PoolConfig } from 'pg'

/**
 * Database connection pool configuration
 */
const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
}

/**
 * Singleton database connection pool
 */
let pool: Pool | null = null

/**
 * Get or create the database connection pool
 * 
 * @returns PostgreSQL connection pool
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(poolConfig)
    
    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err)
    })
  }
  
  return pool
}

/**
 * Close the database connection pool
 * Used for graceful shutdown and testing
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/**
 * Test database connection
 * 
 * @returns True if connection is successful
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = await getPool().connect()
    await client.query('SELECT 1')
    client.release()
    return true
  } catch (error) {
    console.error('Database connection test failed:', error)
    return false
  }
}
