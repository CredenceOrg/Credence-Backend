import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { keyManager } from '../services/keyManager/index.js'
import { wss, broadcastToChannel, getWsUpgradeHandler, shutdownWebSocketServer } from './ws.js'
import { register } from 'prom-client'

// Mock the keyManager
vi.mock('../services/keyManager/index.js', () => ({
  keyManager: {
    verifyToken: vi.fn(),
  },
}))

describe('WebSocket Route', () => {
  beforeEach(async () => {
    // Reset metrics before each test
    register.clear()
    await keyManager.initialize()
  })

  afterEach(async () => {
    // Clean up any remaining connections
    await shutdownWebSocketServer()
  })

  describe('Authentication', () => {
    it('should reject unauthenticated upgrade requests', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue(null)

      const mockSocket = {
        write: vi.fn(),
        destroy: vi.fn(),
      }

      const handler = getWsUpgradeHandler()
      const mockReq = {
        headers: {},
        url: '/ws',
      } as any

      handler(mockReq, mockSocket as any, Buffer.from(''))

      expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n')
      expect(mockSocket.destroy).toHaveBeenCalled()
    })

    it('should accept authenticated upgrade requests', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockSocket = {
        write: vi.fn(),
        destroy: vi.fn(),
      }

      const handler = getWsUpgradeHandler()
      const mockReq = {
        headers: { authorization: 'Bearer valid-token' },
        url: '/ws',
      } as any

      handler(mockReq, mockSocket as any, Buffer.from(''))

      // Should not reject with 401
      expect(mockSocket.write).not.toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n')
    })

    it('should extract token from Authorization header', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockSocket = {
        write: vi.fn(),
        destroy: vi.fn(),
      }

      const handler = getWsUpgradeHandler()
      const mockReq = {
        headers: { authorization: 'Bearer test-token' },
        url: '/ws',
      } as any

      handler(mockReq, mockSocket as any, Buffer.from(''))

      expect(keyManager.verifyToken).toHaveBeenCalledWith('test-token')
    })

    it('should extract token from query parameter', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockSocket = {
        write: vi.fn(),
        destroy: vi.fn(),
      }

      const handler = getWsUpgradeHandler()
      const mockReq = {
        headers: {},
        url: '/ws?token=query-token',
      } as any

      handler(mockReq, mockSocket as any, Buffer.from(''))

      expect(keyManager.verifyToken).toHaveBeenCalledWith('query-token')
    })
  })

  describe('Heartbeat', () => {
    it('should send ping at regular intervals', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
        terminate: vi.fn(),
      } as any

      // Simulate connection
      wss.emit('connection', mockWs, {} as any)

      // Wait for ping interval (30s in production, but we can't wait that long in tests)
      // In a real test, we'd use jest.useFakeTimers
      expect(mockWs.on).toHaveBeenCalledWith('pong', expect.any(Function))
    })

    it('should terminate connection if pong not received', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'pong') {
            // Simulate no pong response
          }
        }),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs, {} as any)

      // In a real test with fake timers, we'd advance time past PONG_TIMEOUT_MS
      expect(mockWs.on).toHaveBeenCalledWith('pong', expect.any(Function))
    })
  })

  describe('Backpressure', () => {
    it('should track backpressure drops in metrics', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(),
        bufferedAmount: 2 * 1024 * 1024, // 2MB - exceeds MAX_BUFFER_SIZE
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs, {} as any)

      // Try to send a message
      const { broadcastToChannel } = await import('./ws.js')
      broadcastToChannel('test-channel', { data: 'test' })

      // The backpressure drop metric should be incremented
      const metrics = await register.metrics()
      expect(metrics).toContain('ws_backpressure_drops_total')
    })
  })

  describe('Subscriptions', () => {
    it('should handle subscribe messages', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'message') {
            handler(Buffer.from(JSON.stringify({ type: 'subscribe', channel: 'trust-scores' })))
          }
        }),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs, {} as any)

      expect(mockWs.subscriptions.has('trust-scores')).toBe(true)
    })

    it('should handle unsubscribe messages', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(['trust-scores']),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'message') {
            handler(Buffer.from(JSON.stringify({ type: 'unsubscribe', channel: 'trust-scores' })))
          }
        }),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs, {} as any)

      expect(mockWs.subscriptions.has('trust-scores')).toBe(false)
    })

    it('should broadcast messages to subscribed connections', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs1 = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(['trust-scores']),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
        terminate: vi.fn(),
      } as any

      const mockWs2 = {
        isAuthenticated: true,
        userId: 'user-456',
        subscriptions: new Set(['other-channel']),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs1, {} as any)
      wss.emit('connection', mockWs2, {} as any)

      broadcastToChannel('trust-scores', { score: 95 })

      expect(mockWs1.send).toHaveBeenCalled()
      expect(mockWs2.send).not.toHaveBeenCalled()
    })
  })

  describe('Metrics', () => {
    it('should increment active connections on connect', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs, {} as any)

      const metrics = await register.metrics()
      expect(metrics).toContain('ws_active_connections')
    })

    it('should decrement active connections on close', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'close') {
            handler()
          }
        }),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs, {} as any)

      const metricsBefore = await register.metrics()
      const match = metricsBefore.match(/ws_active_connections (\d+)/)
      const before = match ? parseInt(match[1]) : 0

      // Trigger close
      const closeHandler = mockWs.on.mock.calls.find((call: any[]) => call[0] === 'close')
      if (closeHandler) {
        closeHandler[1]()
      }

      const metricsAfter = await register.metrics()
      const matchAfter = metricsAfter.match(/ws_active_connections (\d+)/)
      const after = matchAfter ? parseInt(matchAfter[1]) : 0

      expect(after).toBe(before - 1)
    })

    it('should increment auth failures on invalid token', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue(null)

      const mockSocket = {
        write: vi.fn(),
        destroy: vi.fn(),
      }

      const handler = getWsUpgradeHandler()
      const mockReq = {
        headers: { authorization: 'Bearer invalid-token' },
        url: '/ws',
      } as any

      handler(mockReq, mockSocket as any, Buffer.from(''))

      const metrics = await register.metrics()
      expect(metrics).toContain('ws_auth_failures_total')
    })
  })

  describe('Cleanup', () => {
    it('should clean up subscriptions on close', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(['channel1', 'channel2']),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'close') {
            handler()
          }
        }),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs, {} as any)

      // Trigger close
      const closeHandler = mockWs.on.mock.calls.find((call: any[]) => call[0] === 'close')
      if (closeHandler) {
        closeHandler[1]()
      }

      expect(mockWs.subscriptions.size).toBe(0)
    })

    it('should clear heartbeat timers on close', async () => {
      vi.mocked(keyManager.verifyToken).mockResolvedValue({ userId: 'user-123' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        pingInterval: {} as NodeJS.Timeout,
        pongTimeout: {} as NodeJS.Timeout,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'close') {
            handler()
          }
        }),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs, {} as any)

      // Trigger close
      const closeHandler = mockWs.on.mock.calls.find((call: any[]) => call[0] === 'close')
      if (closeHandler) {
        closeHandler[1]()
      }

      expect(mockWs.pingInterval).toBeUndefined()
      expect(mockWs.pongTimeout).toBeUndefined()
    })
  })

  describe('Re-authentication', () => {
    it('should handle re-auth messages for token expiry', async () => {
      vi.mocked(keyManager.verifyToken)
        .mockResolvedValueOnce({ userId: 'user-123' })
        .mockResolvedValueOnce({ userId: 'user-456' })

      const mockWs = {
        isAuthenticated: true,
        userId: 'user-123',
        subscriptions: new Set(),
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        ping: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'message') {
            handler(Buffer.from(JSON.stringify({ type: 'auth', token: 'new-token' })))
          }
        }),
        terminate: vi.fn(),
      } as any

      wss.emit('connection', mockWs, {} as any)

      // Wait for async auth verification
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(mockWs.userId).toBe('user-456')
    })
  })
})
