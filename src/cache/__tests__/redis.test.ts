import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock createClient from redis
vi.mock('redis', () => ({
  createClient: vi.fn(() => ({
    isOpen: false,
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setEx: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
    keys: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(0),
    ttl: vi.fn().mockResolvedValue(-2),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}))

// Import after mocking
import { RedisConnection, CacheService } from '../redis.js'
import { createClient } from 'redis'

// Get the mocked createClient function
const mockCreateClient = vi.mocked(createClient)

describe('RedisConnection', () => {
  let redisConnection: RedisConnection

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset singleton instance
    ;(RedisConnection as any).instance = undefined
    redisConnection = RedisConnection.getInstance()
  })

  afterEach(async () => {
    await redisConnection.forceClose()
  })

  describe('getInstance', () => {
    it('returns the same instance', () => {
      const instance1 = RedisConnection.getInstance()
      const instance2 = RedisConnection.getInstance()
      expect(instance1).toBe(instance2)
    })
  })

  describe('connect', () => {
    it('connects when not connected', async () => {
      const mockClient = mockCreateClient.mock.results[0].value
      mockClient.isOpen = false
      mockClient.connect.mockResolvedValue(undefined)

      await redisConnection.connect()

      expect(mockClient.connect).toHaveBeenCalledTimes(1)
    })

    it('does not connect when already connected', async () => {
      const mockClient = mockCreateClient.mock.results[0].value
      mockClient.isOpen = true

      await redisConnection.connect()

      expect(mockClient.connect).not.toHaveBeenCalled()
    })

    it('handles connection errors gracefully', async () => {
      const mockClient = mockCreateClient.mock.results[0].value
      mockClient.isOpen = false
      mockClient.connect.mockRejectedValue(new Error('Connection failed'))

      await expect(redisConnection.connect()).rejects.toThrow('Connection failed')
    })
  })

  describe('isHealthy', () => {
    it('returns true when Redis is healthy', async () => {
      const mockClient = mockCreateClient.mock.results[0].value
      mockClient.isOpen = true
      mockClient.ping.mockResolvedValue('PONG')

      const healthy = await redisConnection.isHealthy()

      expect(healthy).toBe(true)
      expect(mockClient.ping).toHaveBeenCalledTimes(1)
    })

    it('returns false when Redis is not connected', async () => {
      const mockClient = mockCreateClient.mock.results[0].value
      mockClient.isOpen = false

      const healthy = await redisConnection.isHealthy()

      expect(healthy).toBe(false)
      expect(mockClient.ping).not.toHaveBeenCalled()
    })

    it('returns false when ping fails', async () => {
      const mockClient = mockCreateClient.mock.results[0].value
      mockClient.isOpen = true
      mockClient.ping.mockRejectedValue(new Error('Ping failed'))

      const healthy = await redisConnection.isHealthy()

      expect(healthy).toBe(false)
    })
  })

  describe('disconnect', () => {
    it('disconnects when connected', async () => {
      const mockClient = mockCreateClient.mock.results[0].value
      mockClient.isOpen = true
      mockClient.quit.mockResolvedValue('OK')

      await redisConnection.disconnect()

      expect(mockClient.quit).toHaveBeenCalledTimes(1)
    })

    it('does not disconnect when not connected', async () => {
      const mockClient = mockCreateClient.mock.results[0].value
      mockClient.isOpen = false

      await redisConnection.disconnect()

      expect(mockClient.quit).not.toHaveBeenCalled()
    })
  })
})

describe('CacheService', () => {
  let cacheService: CacheService
  let mockRedisConnection: any

  beforeEach(() => {
    vi.clearAllMocks()
    
    mockRedisConnection = {
      connect: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockReturnValue({
        isOpen: false,
        connect: vi.fn().mockResolvedValue(undefined),
        ping: vi.fn().mockResolvedValue('PONG'),
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        setEx: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(0),
        keys: vi.fn().mockResolvedValue([]),
        exists: vi.fn().mockResolvedValue(0),
        expire: vi.fn().mockResolvedValue(0),
        ttl: vi.fn().mockResolvedValue(-2),
        quit: vi.fn().mockResolvedValue('OK'),
        disconnect: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
      }),
      isHealthy: vi.fn().mockResolvedValue(true),
    }

    cacheService = new CacheService(mockRedisConnection)
  })

  describe('get', () => {
    it('returns parsed JSON value', async () => {
      const testData = { score: 85, address: '0x123' }
      const mockClient = mockRedisConnection.getClient()
      mockClient.get.mockResolvedValue(JSON.stringify(testData))

      const result = await cacheService.get('trust', 'score:0x123')

      expect(result).toEqual(testData)
      expect(mockClient.get).toHaveBeenCalledWith('trust:score:0x123')
    })

    it('returns string value when JSON parsing fails', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.get.mockResolvedValue('plain string value')

      const result = await cacheService.get('test', 'key')

      expect(result).toBe('plain string value')
    })

    it('returns null when key does not exist', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.get.mockResolvedValue(null)

      const result = await cacheService.get('trust', 'nonexistent')

      expect(result).toBeNull()
    })

    it('handles Redis errors gracefully', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.get.mockRejectedValue(new Error('Redis error'))

      const result = await cacheService.get('trust', 'key')

      expect(result).toBeNull()
    })

    it('auto-connects before getting', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.get.mockResolvedValue('value')

      await cacheService.get('test', 'key')

      expect(mockRedisConnection.connect).toHaveBeenCalledTimes(1)
    })
  })

  describe('set', () => {
    it('sets string value without TTL', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.set.mockResolvedValue('OK')

      const result = await cacheService.set('trust', 'score:0x123', '85')

      expect(result).toBe(true)
      expect(mockClient.set).toHaveBeenCalledWith('trust:score:0x123', '85')
    })

    it('sets JSON value with TTL', async () => {
      const testData = { score: 85 }
      const mockClient = mockRedisConnection.getClient()
      mockClient.setEx.mockResolvedValue('OK')

      const result = await cacheService.set('trust', 'score:0x123', testData, 300)

      expect(result).toBe(true)
      expect(mockClient.setEx).toHaveBeenCalledWith(
        'trust:score:0x123', 
        300, 
        JSON.stringify(testData)
      )
    })

    it('handles Redis errors gracefully', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.set.mockRejectedValue(new Error('Redis error'))

      const result = await cacheService.set('trust', 'key', 'value')

      expect(result).toBe(false)
    })

    it('auto-connects before setting', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.set.mockResolvedValue('OK')

      await cacheService.set('test', 'key', 'value')

      expect(mockRedisConnection.connect).toHaveBeenCalledTimes(1)
    })
  })

  describe('delete', () => {
    it('deletes existing key', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.del.mockResolvedValue(1)

      const result = await cacheService.delete('trust', 'score:0x123')

      expect(result).toBe(true)
      expect(mockClient.del).toHaveBeenCalledWith('trust:score:0x123')
    })

    it('returns false for non-existent key', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.del.mockResolvedValue(0)

      const result = await cacheService.delete('trust', 'nonexistent')

      expect(result).toBe(false)
    })

    it('handles Redis errors gracefully', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.del.mockRejectedValue(new Error('Redis error'))

      const result = await cacheService.delete('trust', 'key')

      expect(result).toBe(false)
    })
  })

  describe('healthCheck', () => {
    it('returns healthy status', async () => {
      mockRedisConnection.isHealthy.mockResolvedValue(true)

      const result = await cacheService.healthCheck()

      expect(result).toEqual({ healthy: true })
    })

    it('returns unhealthy status with error', async () => {
      const error = new Error('Connection failed')
      mockRedisConnection.isHealthy.mockRejectedValue(error)

      const result = await cacheService.healthCheck()

      expect(result).toEqual({ healthy: false, error: 'Connection failed' })
    })
  })

  describe('namespacing', () => {
    it('properly namespaces keys', async () => {
      const mockClient = mockRedisConnection.getClient()
      mockClient.get.mockResolvedValue('value')

      await cacheService.get('trust', 'score:0x123')
      await cacheService.get('bond', 'status:0x123')
      await cacheService.get('api', 'response:endpoint')

      expect(mockClient.get).toHaveBeenNthCalledWith(1, 'trust:score:0x123')
      expect(mockClient.get).toHaveBeenNthCalledWith(2, 'bond:status:0x123')
      expect(mockClient.get).toHaveBeenNthCalledWith(3, 'api:response:endpoint')
    })
  })
})

describe('Integration tests', () => {
  describe('singleton behavior', () => {
    it('shares Redis connection across cache instances', () => {
      const cache1 = new CacheService()
      const cache2 = new CacheService()

      // Both should use the same Redis connection
      expect(cache1).toStrictEqual(cache2)
    })
  })
})
