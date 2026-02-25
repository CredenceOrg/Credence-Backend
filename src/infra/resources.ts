/**
 * Shared app resources used by runtime services and graceful shutdown.
 */
export interface AppResources {
  getDbPool(): Promise<import('pg').Pool>
  getRedisClient(): Promise<import('ioredis').default>
  closeDbPool(): Promise<void>
  closeRedis(): Promise<void>
}

/**
 * Creates resource manager for shared DB and Redis connections.
 */
export function createAppResources(): AppResources {
  let dbPool: import('pg').Pool | null = null
  let redisClient: import('ioredis').default | null = null

  return {
    async getDbPool(): Promise<import('pg').Pool> {
      if (dbPool) {
        return dbPool
      }
      const connectionString = process.env.DATABASE_URL
      if (!connectionString) {
        throw new Error('DATABASE_URL is required for DB pool access')
      }
      const pg = (await import('pg')).default
      dbPool = new pg.Pool({ connectionString })
      return dbPool
    },
    async getRedisClient(): Promise<import('ioredis').default> {
      if (redisClient) {
        return redisClient
      }
      const redisUrl = process.env.REDIS_URL
      if (!redisUrl) {
        throw new Error('REDIS_URL is required for Redis client access')
      }
      const Redis = (await import('ioredis')).default
      redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
      return redisClient
    },
    async closeDbPool(): Promise<void> {
      if (!dbPool) {
        return
      }
      await dbPool.end()
      dbPool = null
    },
    async closeRedis(): Promise<void> {
      if (!redisClient) {
        return
      }
      try {
        await redisClient.quit()
      } catch {
        redisClient.disconnect()
      } finally {
        redisClient = null
      }
    },
  }
}
