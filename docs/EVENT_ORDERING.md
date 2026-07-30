# Event Ordering Guarantees

This document details the event ordering guarantees provided by Credence Backend for downstream consumers (integrators, event subscribers, webhooks, and WebSocket clients).

---

## Audience

This document is written for **downstream integrators** who consume real-time events, webhooks, or transactional outbox updates emitted by Credence Backend.

---

## Guarantees Summary

| Channel / Context | Ordering Guarantee | Key / Partition Scope | Delivery Semantics |
|---|---|---|---|
| **Transactional Outbox** | Strictly Ordered | Per Aggregate (`aggregateType` + `aggregateId`) | At-Least-Once |
| **Outbox (Sharded Multi-Publisher)** | Strictly Ordered per Aggregate | Per Aggregate (`aggregateType` + `aggregateId`) | At-Least-Once |
| **Webhooks (HTTP Push)** | Best-Effort Sequential with Replay Window Tolerance | Per Subscription / Endpoint | At-Least-Once |
| **WebSocket Subscriptions** | Sequential in-session for subscribed streams | Per Connection (`ws://.../ws`) | At-Least-Once |
| **Ledger / Horizon Ingestion** | Monotonically Increasing | Ledger Sequence Number (`ledgerSequence`) | At-Least-Once |

---

## 1. Transactional Outbox Ordering

### Scope & Behavior

Events produced within business operations (such as bond creations, attestations, and status transitions) are persisted atomically inside the SQL database transaction via the `event_outbox` table.

For events sharing the exact same **`aggregateType`** and **`aggregateId`**, Credence Backend guarantees **strict sequential processing**.

### Real-World Example

When an identity updates its bond balance twice in rapid succession:

#### 1. Outbox Event Records

```json
[
  {
    "id": "1001",
    "aggregateType": "identity",
    "aggregateId": "id_stellar_0xabc123",
    "eventType": "bond.updated",
    "payload": {
      "previousAmount": "1000",
      "newAmount": "1500"
    },
    "createdAt": "2026-07-25T10:00:00.000Z"
  },
  {
    "id": "1002",
    "aggregateType": "identity",
    "aggregateId": "id_stellar_0xabc123",
    "eventType": "bond.updated",
    "payload": {
      "previousAmount": "1500",
      "newAmount": "2000"
    },
    "createdAt": "2026-07-25T10:00:01.000Z"
  }
]
```

#### 2. Guarantee in Code Execution

The publisher worker fetches claimed events and groups them by `aggregateType:aggregateId`. Events under `identity:id_stellar_0xabc123` are emitted strictly in ascending order of `id` (and creation order):

```typescript
// OutboxPublisher grouping & sequential dispatch (from src/db/outbox/publisher.ts)
const aggregateGroups = groupEventsByAggregate(claimedEvents);

for (const group of aggregateGroups) {
  for (const event of group.events) {
    // Event 1001 is guaranteed to complete before Event 1002 is attempted
    await this.dispatcher.publish(event);
  }
}
```

### Multi-Instance Sharding Behavior

When horizontal scaling is enabled (`OutboxPublisher` lease-aware sharding via `shardCount` and `shardId`), events are sharded by an MD5 modulo hash on event ID:

$$\text{ToInt32}(\text{Substring}(\text{MD5}(id), 1, 8)) \pmod N = S$$

Even with multiple horizontal workers running concurrently, per-aggregate ordering is preserved within each worker batch. Cross-aggregate events (e.g. `identity:A` vs `identity:B`) may be processed concurrently across worker nodes.

---

## 2. Webhook Event Delivery

### Scope & Behavior

Webhooks are delivered over HTTP POST with HMAC-SHA256 signature headers (`X-Credence-Signature` and `X-Credence-Timestamp`). 

- **At-Least-Once Delivery**: Webhooks may be retried upon network timeouts or non-2xx responses.
- **Replay & Retry Window**: Downstream consumers should tolerate retries within the 5-minute replay tolerance window.
- **Replay-Safe Side-Effects**: Retried handler executions in Credence Backend execute only side-effects marked as `replaySafe`.

### Real-World Webhook Request Payload Example

```http
POST /webhooks/receive HTTP/1.1
Host: consumer.example.com
Content-Type: application/json
X-Credence-Signature: t=1784980800,v1=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a
X-Credence-Timestamp: 1784980800

{
  "id": "evt_outbox_1001",
  "event": "identity.score_updated",
  "timestamp": "2026-07-25T10:00:00Z",
  "data": {
    "identityAddress": "GAAXEXAMPLESTELLARADDRESS12345",
    "previousScore": 720,
    "newScore": 765,
    "reason": "bond_increase"
  }
}
```

### Downstream Consumer Handling Recommendation

Because network retries can cause out-of-order delivery over public HTTP, downstream webhook consumers **MUST** use state versioning or timestamps rather than assuming strict HTTP arrival order.

#### Consumer Handling Example (Node.js/TypeScript)

```typescript
interface ScoreUpdatedWebhook {
  id: string;
  event: string;
  timestamp: string;
  data: {
    identityAddress: string;
    previousScore: number;
    newScore: number;
  };
}

async function handleWebhook(payload: ScoreUpdatedWebhook): Promise<void> {
  const eventTime = new Date(payload.timestamp).getTime();

  // 1. Fetch current local state for aggregate
  const existingRecord = await db.identities.find(payload.data.identityAddress);

  // 2. Ignore stale events delivered out-of-order
  if (existingRecord && existingRecord.lastUpdatedMs >= eventTime) {
    console.log(`Ignoring out-of-order or duplicate event: ${payload.id}`);
    return;
  }

  // 3. Apply state update atomically
  await db.identities.update(payload.data.identityAddress, {
    score: payload.data.newScore,
    lastUpdatedMs: eventTime,
  });
}
```

---

## 3. WebSocket Subscription Ordering

### Scope & Behavior

Clients subscribing to real-time streams via `/ws` receive messages sequentially for active stream subscriptions over the persistent TCP connection.

### Protocol Lifecycle Example

```json
// 1. Client subscribe request
{
  "type": "subscribe",
  "channel": "trust_score",
  "aggregateId": "GAAXEXAMPLESTELLARADDRESS12345"
}

// 2. Server broadcast message (Message #1)
{
  "type": "event",
  "channel": "trust_score",
  "sequence": 412,
  "timestamp": "2026-07-25T10:00:00.000Z",
  "payload": {
    "identityAddress": "GAAXEXAMPLESTELLARADDRESS12345",
    "score": 765
  }
}

// 3. Server broadcast message (Message #2)
{
  "type": "event",
  "channel": "trust_score",
  "sequence": 413,
  "timestamp": "2026-07-25T10:00:05.000Z",
  "payload": {
    "identityAddress": "GAAXEXAMPLESTELLARADDRESS12345",
    "score": 780
  }
}
```

If a client disconnects and reconnects, messages emitted during the disconnection gap are not automatically buffered on the WebSocket connection. Consumers should perform a initial REST query upon reconnection to catch up.

---

## 4. Ledger & Horizon Ingestion Guarantees

### Scope & Behavior

On-chain Stellar/Soroban event synchronization is bound by ledger sequence numbers (`ledgerSequence`).

- **Monotonic Sequence Guarantee**: Events parsed from Horizon transactions are processed in strictly ascending order of `ledgerSequence` and transaction index.
- **Idempotent Replay**: Re-ingesting a previously processed ledger range is safe because processing handlers use unique transaction hashes and ledger numbers as idempotency deduplication keys.

---

## Summary Checklist for Integrators

1. **Rely on `aggregateType` + `aggregateId`** for sequential transaction guarantees in outbox events.
2. **Use idempotency keys** (such as event `id` or `X-Credence-Signature`) to deduplicate retried webhook deliveries.
3. **Check state timestamps / sequence numbers** when updating downstream cached state.
4. **Re-sync via REST** upon WebSocket reconnection to handle gaps during connection loss.
