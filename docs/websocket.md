# WebSocket API Documentation

## Overview

The WebSocket endpoint (`/ws`) provides real-time subscriptions for live data updates, such as trust-score change notifications. This implementation includes authentication, heartbeat monitoring, backpressure handling, and comprehensive metrics.

## Endpoint

**URL:** `ws://host:port/ws`

**Authentication Required:** Yes (JWT token)

## Authentication

WebSocket connections must be authenticated using a valid JWT token. The token can be provided in two ways:

1. **Authorization Header:** `Bearer <token>`
2. **Query Parameter:** `?token=<token>`

### Token Verification

- Tokens are verified using the existing JWKS infrastructure (`src/services/keyManager/index.js`)
- Tokens must include a `sub` claim representing the user ID
- Invalid or expired tokens result in immediate connection rejection (HTTP 401)

### Re-authentication

If a token expires mid-connection, clients can send a re-authentication message:

```json
{
  "type": "auth",
  "token": "new-jwt-token"
}
```

## Connection Lifecycle

### 1. Upgrade Request

Client initiates WebSocket upgrade with authentication:

```javascript
const ws = new WebSocket('ws://localhost:3000/ws?token=your-jwt-token')
```

### 2. Server Response

On successful connection, server sends:

```json
{
  "type": "connected",
  "userId": "user-123",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 3. Heartbeat

- Server sends ping every 30 seconds
- Client must respond with pong
- If no pong received within 60 seconds, connection is terminated
- This ensures dead connections are cleaned up

### 4. Subscription

Client subscribes to channels:

```json
{
  "type": "subscribe",
  "channel": "trust-scores"
}
```

Server confirms:

```json
{
  "type": "subscribed",
  "channel": "trust-scores",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 5. Receiving Messages

When subscribed to a channel, client receives:

```json
{
  "type": "channel_message",
  "channel": "trust-scores",
  "data": {
    "address": "GABC...",
    "score": 95
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 6. Unsubscription

Client unsubscribes from channels:

```json
{
  "type": "unsubscribe",
  "channel": "trust-scores"
}
```

Server confirms:

```json
{
  "type": "unsubscribed",
  "channel": "trust-scores",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 7. Connection Close

Server closes connection on:
- Client disconnect
- Heartbeat timeout (no pong response)
- Backpressure limit exceeded
- Server shutdown

## Message Types

### Client → Server

| Type | Description | Fields |
|------|-------------|--------|
| `subscribe` | Subscribe to a channel | `channel` (string) |
| `unsubscribe` | Unsubscribe from a channel | `channel` (string) |
| `auth` | Re-authenticate with new token | `token` (string) |

### Server → Client

| Type | Description | Fields |
|------|-------------|--------|
| `connected` | Connection established | `userId`, `timestamp` |
| `subscribed` | Subscription confirmed | `channel`, `timestamp` |
| `unsubscribed` | Unsubscription confirmed | `channel`, `timestamp` |
| `channel_message` | Message from subscribed channel | `channel`, `data`, `timestamp` |
| `auth_success` | Re-authentication successful | `timestamp` |
| `auth_failed` | Re-authentication failed | `timestamp` |

## Backpressure Handling

To prevent memory leaks from slow clients, the WebSocket implementation enforces:

- **Maximum buffer size:** 1MB per connection
- **Maximum queued messages:** 100 messages
- **Action:** Connections exceeding limits are dropped with metric increment

Clients that cannot keep up with message rates will be disconnected to protect server stability.

## Available Channels

Currently supported channels:

- `trust-scores` - Trust score change notifications
- Additional channels can be added as needed

## Metrics

The WebSocket endpoint exposes Prometheus metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `ws_active_connections` | Gauge | Number of currently active connections |
| `ws_auth_failures_total` | Counter | Total authentication failures |
| `ws_backpressure_drops_total` | Counter | Total connections dropped due to backpressure |
| `ws_connections_total` | Counter | Total connection attempts |

Metrics are available at the `/metrics` endpoint.

## Configuration

WebSocket behavior can be configured via environment variables (add to `.env`):

```bash
# WebSocket Configuration
WS_PING_INTERVAL_MS=30000        # Ping interval (default: 30s)
WS_PONG_TIMEOUT_MS=60000         # Pong timeout (default: 60s)
WS_MAX_BUFFER_SIZE=1048576       # Max buffer size in bytes (default: 1MB)
WS_MAX_QUEUED_MESSAGES=100       # Max queued messages (default: 100)
```

## Security Considerations

1. **Authentication:** All connections must present a valid JWT token
2. **Token Expiry:** Tokens are verified on connection; re-auth required for expiry
3. **Resource Limits:** Backpressure limits prevent DoS via slow clients
4. **Heartbeat:** Dead connections are automatically terminated
5. **Cleanup:** Subscriptions are cleared on connection close

## Error Handling

### Connection Errors

- **401 Unauthorized:** Invalid or missing authentication token
- **500 Internal Server Error:** Server-side error during upgrade

### Message Errors

- Malformed JSON messages are silently ignored
- Invalid message types are silently ignored

## Graceful Shutdown

On server shutdown (SIGTERM/SIGINT):

1. WebSocket server closes all connections with code 1001
2. Heartbeat timers are cleared
3. Subscriptions are cleaned up
4. HTTP server closes

## Client Implementation Example

```javascript
class CredenceWebSocket {
  constructor(url, token) {
    this.ws = new WebSocket(`${url}?token=${token}`)
    this.subscriptions = new Set()
    
    this.ws.onopen = () => {
      console.log('WebSocket connected')
    }
    
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      this.handleMessage(message)
    }
    
    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error)
    }
    
    this.ws.onclose = () => {
      console.log('WebSocket disconnected')
    }
  }
  
  handleMessage(message) {
    switch (message.type) {
      case 'connected':
        console.log(`Connected as ${message.userId}`)
        break
      case 'subscribed':
        console.log(`Subscribed to ${message.channel}`)
        this.subscriptions.add(message.channel)
        break
      case 'unsubscribed':
        console.log(`Unsubscribed from ${message.channel}`)
        this.subscriptions.delete(message.channel)
        break
      case 'channel_message':
        console.log(`Message on ${message.channel}:`, message.data)
        break
    }
  }
  
  subscribe(channel) {
    this.ws.send(JSON.stringify({
      type: 'subscribe',
      channel
    }))
  }
  
  unsubscribe(channel) {
    this.ws.send(JSON.stringify({
      type: 'unsubscribe',
      channel
    }))
  }
  
  close() {
    this.ws.close()
  }
}

// Usage
const ws = new CredenceWebSocket('ws://localhost:3000/ws', 'your-jwt-token')
ws.subscribe('trust-scores')
```

## Testing

Run WebSocket tests:

```bash
npm test -- ws
```

Tests cover:
- Authentication (valid/invalid tokens)
- Heartbeat (ping/pong)
- Backpressure (buffer limits)
- Subscriptions (subscribe/unsubscribe/broadcast)
- Metrics (connection tracking)
- Cleanup (connection close)

## Troubleshooting

### Connection Refused (401)

- Verify JWT token is valid and not expired
- Check token includes `sub` claim
- Ensure token is passed correctly (header or query param)

### Connection Dropped

- Check if client is responding to pings
- Verify client can handle message rate
- Review backpressure metrics

### No Messages Received

- Verify subscription to correct channel
- Check channel name matches exactly
- Ensure server is publishing to the channel

## Future Enhancements

Potential improvements:

- Per-channel rate limiting
- Message replay for reconnections
- Connection-specific message filtering
- WebSocket compression (optional)
- Connection pooling for high-scale scenarios
