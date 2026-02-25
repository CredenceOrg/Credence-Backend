import { Pool } from 'pg'

let pool: Pool | null = null

export function getDbPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required')
    }
    pool = new Pool({ connectionString: url })
  }
  return pool
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}