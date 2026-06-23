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

### Payload Size Limits & Chunking

- The default maximum payload size is 256KB (configurable via `WEBHOOK_PAYLOAD_SIZE_CAP` environment variable)
- If a payload exceeds this limit and `data` is an array/list, the system will automatically split it into multiple chunks
  - Each chunk includes additional metadata:
    - `chunkId`: A unique identifier for the entire multi-chunk event
    - `chunkIndex`: 0-based index of the current chunk
    - `totalChunks`: Total number of chunks in the sequence
- If a payload cannot be split into chunks (e.g., `data` is an object, or a single item exceeds the limit), it will be sent with `payloadTruncated: true`

#### Example of Chunked Payload (Chunk 1 of 2):

```json
{
  "event": "bond.created",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": [
    { "address": "0xabc...", "bondedAmount": "1000" },
    { "address": "0xdef...", "bondedAmount": "2000" }
  ],
  "chunkId": "a1b2c3d4e5f6...",
  "chunkIndex": 0,
  "totalChunks": 2
}
```

#### Example of Truncated Payload:

```json
{
  "event": "bond.created",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": { "address": "0xabc...", "veryLargeField": "..." },
  "payloadTruncated": true
}
```

## Security

Payloads are signed with HMAC-SHA256. Verify using the `X-Webhook-Signature` header:

```typescript
import { createHmac } from "crypto";

const signature = createHmac("sha256", secret)
  .update(requestBody)
  .digest("hex");

if (signature !== request.headers["x-webhook-signature"]) {
  throw new Error("Invalid signature");
}
```

## Mutual TLS (mTLS) Support

For enterprise subscribers requiring mutual TLS authentication, webhooks can be configured with client certificates and server certificate pinning.

### Configuration

The webhook configuration supports optional mTLS fields:

- `clientCertPem` - PEM-encoded client certificate for mTLS authentication
- `clientKeyKmsRef` - KMS reference for client private key (never stored as plaintext)
- `pinnedServerCertSha256` - SHA256 hash of pinned server certificate for certificate pinning

### Certificate Rotation

Client certificates can be rotated by updating the `clientCertPem` and `clientKeyKmsRef` fields. The system supports:

- Grace period for certificate rotation (24 hours by default)
- Automatic retry with exponential backoff on temporary certificate issues
- Certificate pinning validation to prevent man-in-the-middle attacks

### Error Handling

mTLS-specific failures emit the `WEBHOOK_MTLS_FAILURE` error code and are tracked via the `webhook_mtls_failure_total` metric with labels:

- `subscriber` - webhook ID
- `reason` - specific failure reason (e.g., `cert_pin_mismatch`, `handshake_failure`)

### Security Best Practices

1. **Client Key Storage**: Client private keys are stored only as KMS references, never in plaintext
2. **Certificate Pinning**: Server certificate hashes are compared in constant time to prevent timing attacks
3. **Rotation Support**: Certificate rotation is supported with a grace period to avoid service disruption
4. **Fail-Safe**: mTLS configuration is optional; webhooks without mTLS continue to work with standard HTTPS

## Delivery

- Automatic retry with exponential backoff (max 3 attempts, configurable per webhook)
- 5 second timeout per request (configurable per webhook)
- Rate limited to 1 delivery per webhook per 100ms
- 4xx errors are not retried
- mTLS handshake failures emit specific error codes for debugging

## Usage

```typescript
import { createWebhookService } from "./services/webhooks/index.js";

// Create service with webhook store and postgres DLQ store
const dlqStore = new PostgresDlqStore(pool);
const webhookService = new WebhookService(
  store,
  {
    maxRetries: 3,
    initialDelay: 1000,
    timeout: 5000,
  },
  dlqStore,
);

// Emit event
await webhookService.emit("bond.created", {
  address: "0xabc",
  bondedAmount: "1000",
  bondStart: 1234567890,
  bondDuration: 86400,
  active: true,
});
```

### mTLS Configuration Example

```typescript
// Configure webhook with mTLS
await webhookService.register({
  url: "https://enterprise.example.com/webhook",
  events: ["bond.created", "bond.slashed"],
  secret: "hmac-signing-secret",
  clientCertPem: "-----BEGIN CERTIFICATE-----\n...",
  clientKeyKmsRef: "kms://arn:aws:kms:us-east-1:123456789012:key/abc123",
  pinnedServerCertSha256: "a1b2c3d4e5f6...",
  timeoutMs: 10000,
  maxAttempts: 5,
});
```

## Dead Letter Queue (DLQ)

Failed webhook deliveries (e.g. max retries exceeded or 4xx responses) are permanently stored in a Postgres-backed Dead Letter Queue (`webhook_dlq` table).

- **Durability**: Survives application restarts and deployments.
- **Metrics**: The current size of the DLQ is exposed as a Prometheus gauge `webhook_dlq_size`.
- **Replayability**: DLQ entries can be inspected and manually replayed, updating the `replayed_at` timestamp.
- **mTLS Failures**: mTLS-specific failures include the `WEBHOOK_MTLS_FAILURE` error code for identification.

## Integration

### Identity state changes (authoritative path)

Bond lifecycle webhooks for identity state changes must be emitted through the
**transactional outbox** so delivery survives process crashes and rolls back with
failed state updates. Use `webhookIntegrationOutbox.ts`:

```typescript
import { emitWebhookForStateChange } from "./listeners/webhookIntegrationOutbox.js";

// Within the same database transaction as the state update
await db.transaction(async (tx) => {
  const oldState = await store.get(address, tx);
  await store.set(newState, tx);
  await emitWebhookForStateChange(tx, oldState, newState);
});
```

Event type detection is shared in `webhookEventDetection.ts` (`detectEventType`).
Both integration modules import it so detection logic cannot drift.

### Deprecated direct path

`webhookIntegration.ts` emitted webhooks by calling `webhookService.emit()` directly
after the state write, outside the outbox. **This path is deprecated** — it is not
crash-safe and can double-emit if both paths are used. No internal callers depend on
it; migrate to `webhookIntegrationOutbox.ts`.

| Module | Status | When to use |
| --- | --- | --- |
| `webhookEventDetection.ts` | Shared | Import `detectEventType` only if you need detection without emission |
| `webhookIntegrationOutbox.ts` | **Authoritative** | All new identity-state webhook integration |
| `webhookIntegration.ts` | Deprecated | Do not use in new code; will be removed in a future release |

### Migration from direct to outbox

```typescript
// Before (deprecated)
await store.set(newState);
await emitWebhookForStateChange(webhookService, oldState, newState);

// After (authoritative)
await db.transaction(async (tx) => {
  await store.set(newState, tx);
  await emitWebhookForStateChange(tx, oldState, newState);
});
```

The outbox publisher (`src/db/outbox/webhookPublisher.ts`) delivers events to
registered webhook endpoints asynchronously. See `src/db/outbox/README.md` for
outbox architecture details.

## Monitoring

Key metrics for webhook delivery:

- `webhook_delivery_duration` - Time taken for webhook delivery attempts
- `webhook_timeout_total` - Count of webhook timeouts
- `webhook_mtls_failure_total` - Count of mTLS-specific failures (with `subscriber` and `reason` labels)
- `webhook_dlq_size` - Current size of the dead letter queue
- `webhook_payload_bytes` - Histogram of webhook payload sizes in bytes (with `subscriber` label)
