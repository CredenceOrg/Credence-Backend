import { Server, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { keyManager } from '../services/keyManager/index.js'
import { register, Gauge, Counter } from 'prom-client'

/**
 * WebSocket connection metrics
 */
const wsActiveConnections = new Gauge({
  name: 'ws_active_connections',
  help: 'Number of currently active WebSocket connections',
  registers: [register],
})

const wsAuthFailures = new Counter({
  name: 'ws_auth_failures_total',
  help: 'Total number of WebSocket authentication failures',
  registers: [register],
})

const wsBackpressureDrops = new Counter({
  name: 'ws_backpressure_drops_total',
  help: 'Total number of connections dropped due to backpressure',
  registers: [register],
})

const wsConnectionsTotal = new Counter({
  name: 'ws_connections_total',
  help: 'Total number of WebSocket connection attempts',
  registers: [register],
})

/**
 * Configuration for WebSocket hardening
 */
const WS_CONFIG = {
  // Heartbeat: send ping every 30 seconds
  PING_INTERVAL_MS: 30000,
  // Close connection if no pong received within 60 seconds
  PONG_TIMEOUT_MS: 60000,
  // Maximum send buffer size per connection (1MB)
  MAX_BUFFER_SIZE: 1024 * 1024,
  // Maximum number of queued messages before dropping
  MAX_QUEUED_MESSAGES: 100,
} as const

/**
 * Extended WebSocket interface with connection metadata
 */
interface AuthenticatedWebSocket extends WebSocket {
  isAuthenticated: boolean
  userId?: string
  lastPong?: number
  pingInterval?: NodeJS.Timeout
  pongTimeout?: NodeJS.Timeout
  subscriptions: Set<string>
}

/**
 * Verify JWT token from WebSocket upgrade request or first message
 */
async function verifyAuthToken(token: string): Promise<{ userId: string } | null> {
  try {
    const payload = await keyManager.verifyToken(token)
    const sub = payload.sub as string | undefined
    if (!sub) {
      return null
    }
    return { userId: sub }
  } catch (error) {
    return null
  }
}

/**
 * Extract token from query string or Authorization header
 */
function extractTokenFromRequest(req: IncomingMessage): string | null {
  // Try Authorization header first
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  // Try query parameter
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  return url.searchParams.get('token')
}

/**
 * Send a message with backpressure checking
 * Returns false if the message was dropped due to backpressure
 */
function sendMessageSafe(ws: AuthenticatedWebSocket, data: string | Buffer): boolean {
  // Check buffer size
  const bufferSize = ws.bufferedAmount
  if (bufferSize > WS_CONFIG.MAX_BUFFER_SIZE) {
    wsBackpressureDrops.inc()
    return false
  }

  // Check if send would block (bufferedAmount > 0 means buffer not empty)
  if (bufferSize > 0 && ws.readyState === WebSocket.OPEN) {
    // If buffer is growing, check against queued message limit
    const queuedMessages = Math.floor(bufferSize / 1024) // rough estimate
    if (queuedMessages > WS_CONFIG.MAX_QUEUED_MESSAGES) {
      wsBackpressureDrops.inc()
      return false
    }
  }

  try {
    ws.send(data)
    return true
  } catch (error) {
    wsBackpressureDrops.inc()
    return false
  }
}

/**
 * Setup heartbeat for a connection
 */
function setupHeartbeat(ws: AuthenticatedWebSocket): void {
  // Send ping periodically
  ws.pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping()
    }
  }, WS_CONFIG.PING_INTERVAL_MS)

  // Set timeout for pong response
  ws.pongTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.terminate()
    }
  }, WS_CONFIG.PONG_TIMEOUT_MS)
}

/**
 * Clear heartbeat timers
 */
function clearHeartbeat(ws: AuthenticatedWebSocket): void {
  if (ws.pingInterval) {
    clearInterval(ws.pingInterval)
    ws.pingInterval = undefined
  }
  if (ws.pongTimeout) {
    clearTimeout(ws.pongTimeout)
    ws.pongTimeout = undefined
  }
}

/**
 * Clean up subscriptions on connection close
 */
function cleanupSubscriptions(ws: AuthenticatedWebSocket): void {
  ws.subscriptions.clear()
}

/**
 * Handle WebSocket connection upgrade
 */
function handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
  wsConnectionsTotal.inc()

  // Extract and verify token from upgrade request
  const token = extractTokenFromRequest(req)
  if (!token) {
    wsAuthFailures.inc()
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  verifyAuthToken(token).then((auth) => {
    if (!auth) {
      wsAuthFailures.inc()
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Handle the upgrade
    wss.handleUpgrade(req, socket, head, (ws) => {
      const authWs = ws as AuthenticatedWebSocket
      authWs.isAuthenticated = true
      authWs.userId = auth.userId
      authWs.subscriptions = new Set()

      wss.emit('connection', authWs, req)
    })
  }).catch(() => {
    wsAuthFailures.inc()
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
    socket.destroy()
  })
}

/**
 * Create and configure the WebSocket server
 */
export const wss = new Server({
  noServer: true,
  perMessageDeflate: false, // Disable compression to reduce CPU
})

/**
 * Handle new WebSocket connections
 */
wss.on('connection', (ws: AuthenticatedWebSocket, req: IncomingMessage) => {
  if (!ws.isAuthenticated) {
    wsAuthFailures.inc()
    ws.close(1008, 'Authentication required')
    return
  }

  wsActiveConnections.inc()

  // Setup heartbeat
  setupHeartbeat(ws)

  // Handle pong responses
  ws.on('pong', () => {
    ws.lastPong = Date.now()
    // Reset pong timeout
    if (ws.pongTimeout) {
      clearTimeout(ws.pongTimeout)
      ws.pongTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.terminate()
        }
      }, WS_CONFIG.PONG_TIMEOUT_MS)
    }
  })

  // Handle incoming messages
  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString())

      // Handle subscription messages
      if (message.type === 'subscribe') {
        const channel = message.channel as string
        if (channel) {
          ws.subscriptions.add(channel)
          sendMessageSafe(ws, JSON.stringify({
            type: 'subscribed',
            channel,
            timestamp: new Date().toISOString(),
          }))
        }
      }

      // Handle unsubscription messages
      if (message.type === 'unsubscribe') {
        const channel = message.channel as string
        if (channel) {
          ws.subscriptions.delete(channel)
          sendMessageSafe(ws, JSON.stringify({
            type: 'unsubscribed',
            channel,
            timestamp: new Date().toISOString(),
          }))
        }
      }

      // Handle re-authentication (token expiry mid-connection)
      if (message.type === 'auth') {
        const token = message.token as string
        verifyAuthToken(token).then((auth) => {
          if (auth) {
            ws.userId = auth.userId
            sendMessageSafe(ws, JSON.stringify({
              type: 'auth_success',
              timestamp: new Date().toISOString(),
            }))
          } else {
            wsAuthFailures.inc()
            sendMessageSafe(ws, JSON.stringify({
              type: 'auth_failed',
              timestamp: new Date().toISOString(),
            }))
          }
        })
      }
    } catch (error) {
      // Ignore malformed messages
    }
  })

  // Handle connection close
  ws.on('close', () => {
    wsActiveConnections.dec()
    clearHeartbeat(ws)
    cleanupSubscriptions(ws)
  })

  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error)
    clearHeartbeat(ws)
    cleanupSubscriptions(ws)
  })

  // Send welcome message
  sendMessageSafe(ws, JSON.stringify({
    type: 'connected',
    userId: ws.userId,
    timestamp: new Date().toISOString(),
  }))
})

/**
 * Broadcast a message to all subscribed connections
 */
export function broadcastToChannel(channel: string, message: unknown): void {
  wss.clients.forEach((client) => {
    const ws = client as AuthenticatedWebSocket
    if (
      ws.readyState === WebSocket.OPEN &&
      ws.isAuthenticated &&
      ws.subscriptions.has(channel)
    ) {
      sendMessageSafe(ws, JSON.stringify({
        type: 'channel_message',
        channel,
        data: message,
        timestamp: new Date().toISOString(),
      }))
    }
  })
}

/**
 * Get the upgrade handler for Express integration
 */
export function getWsUpgradeHandler() {
  return handleUpgrade
}

/**
 * Gracefully shutdown the WebSocket server
 */
export function shutdownWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    wss.clients.forEach((client) => {
      const ws = client as AuthenticatedWebSocket
      clearHeartbeat(ws)
      cleanupSubscriptions(ws)
      ws.close(1001, 'Server shutting down')
    })
    wss.close(() => {
      resolve()
    })
  })
}
