# Webhook Notifications

Webhook system for delivering bond lifecycle events to registered endpoints.

## Events

- `bond.created` - Bond becomes active
- `bond.slashed` - Bond amount decreases while active
- `bond.withdrawn` - Bond becomes inactive with zero amount

## Payload Format

```json
{
  "event": "bond.created",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "address": "0xabc...",
    "bondedAmount": "1000",
    "bondStart": 1234567890,
    "bondDuration": 86400,
    "active": true
  }
}
```

## Security

Payloads are signed with HMAC-SHA256. Verify using the `X-Webhook-Signature` header:

```typescript
import { createHmac } from 'crypto'

const signature = createHmac('sha256', secret)
  .update(requestBody)
  .digest('hex')

if (signature !== request.headers['x-webhook-signature']) {
  throw new Error('Invalid signature')
}
```

## Delivery

- Automatic retry with exponential backoff (max 3 attempts)
- 5 second timeout per request
- Rate limited to 1 delivery per webhook per 100ms
- 4xx errors are not retried

## Usage

```typescript
import { createWebhookService } from './services/webhooks/index.js'

// Create service with webhook store
const webhookService = createWebhookService(store, {
  maxRetries: 3,
  initialDelay: 1000,
  timeout: 5000,
})

// Emit event
await webhookService.emit('bond.created', {
  address: '0xabc',
  bondedAmount: '1000',
  bondStart: 1234567890,
  bondDuration: 86400,
  active: true,
})
```

## Integration

Integrate with identity state sync:

```typescript
import { emitWebhookForStateChange } from './listeners/webhookIntegration.js'

// After updating state
const oldState = await store.get(address)
await store.set(newState)
await emitWebhookForStateChange(webhookService, oldState, newState)
```
