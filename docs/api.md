# Credence API Reference

- OpenAPI spec: [`docs/openapi.yaml`](openapi.yaml)
- Postman collection: [`docs/credence.postman_collection.json`](credence.postman_collection.json)

---

## Base URL

| Environment       | URL                                   |
| ----------------- | ------------------------------------- |
| Local development | `http://localhost:3000`               |
| Production        | _(configured via `BASE_URL` env var)_ |

---

## Authentication

All endpoints are publicly readable. Supply an `X-API-Key` header to unlock
the **premium** rate tier.

```
X-API-Key: <your-key>
```

| Header present    | Tier     |
| ----------------- | -------- |
| No                | standard |
| Yes (valid key)   | premium  |
| Yes (invalid key) | standard |

---

## Address format

All `:address` path parameters must be Ethereum addresses:
`0x` followed by exactly 40 hexadecimal characters.
Accepted in any case (EIP-55 checksummed or all lower-case).

**Valid:** `0xf39Fd6e51aad88F6f4ce6aB8827279cffFb92266`
**Invalid:** `0x1234`, `f39fd6...` (no `0x` prefix), `not-an-address`

---

## Endpoints

### `GET /api/health`

Returns readiness status for the service and its critical dependencies.

```
GET /api/health
```

**Response `200`** when all configured critical dependencies are healthy.

**Response `503`** when any critical dependency is down.

**Response `200`** example:

```json
{
  "status": "ok",
  "service": "credence-backend",
  "version": {
    "gitSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "buildTimestamp": "2026-06-25T20:00:00.000Z",
    "nodeVersion": "v20.10.0"
  },
  "dependencies": {
    "postgres": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "up", "latencyMs": 2 },
    "horizonListener": { "status": "up", "latencyMs": 4 },
    "outboxPublisher": { "status": "up", "latencyMs": 5, "lagSeconds": 0 },
    "horizon": { "status": "up", "latencyMs": 3 }
  }
}
```

**Response `503`** example when outbox lag exceeds threshold:

```json
{
  "status": "unhealthy",
  "service": "credence-backend",
  "version": {
    "gitSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "buildTimestamp": "2026-06-25T20:00:00.000Z",
    "nodeVersion": "v20.10.0"
  },
  "dependencies": {
    "postgres": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "up", "latencyMs": 2 },
    "horizonListener": { "status": "up", "latencyMs": 4 },
    "outboxPublisher": { "status": "down", "lagSeconds": 61 },
    "horizon": { "status": "up", "latencyMs": 3 }
  }
}
```

---

### `GET /api/trust/:address`

Returns the computed trust score and identity data for an Ethereum address.

```
GET /api/trust/:address
```

**Score algorithm**

The score is an integer `[0, 100]` built from three components:

| Component     | Max pts | Maxes when        |
| ------------- | ------- | ----------------- |
| Bond amount   | 50      | ≥ 1 ETH bonded    |
| Bond duration | 20      | bonded ≥ 365 days |
| Attestations  | 30      | ≥ 5 attestations  |

**Path parameters**

| Parameter | Type   | Description                                                           |
| --------- | ------ | --------------------------------------------------------------------- |
| `address` | string | Ethereum address — `0x`-prefixed, 40 hex chars (EIP-55 or lower-case) |

**Headers (optional)**

| Header      | Description                   |
| ----------- | ----------------------------- |
| `X-API-Key` | API key for premium rate tier |

**Responses**

| Status | Condition                                 |
| ------ | ----------------------------------------- |
| `200`  | Identity found; returns TrustScore object |
| `400`  | Address format invalid                    |
| `404`  | No identity record for this address       |

**`200` example — fully bonded identity**

```json
{
  "address": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "score": 100,
  "bondedAmount": "1000000000000000000",
  "bondStart": "2024-01-15T00:00:00.000Z",
  "attestationCount": 5,
  "agreedFields": {
    "name": "Alice",
    "role": "validator"
  }
}
```

**`200` example — unbonded identity (score 0)**

```json
{
  "address": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "score": 0,
  "bondedAmount": "0",
  "bondStart": null,
  "attestationCount": 0
}
```

**`400` example**

```json
{
  "error": "Invalid address format. Expected an Ethereum address: 0x followed by 40 hex characters."
}
```

**`404` example**

```json
{
  "error": "No identity record found for address 0x1234567890123456789012345678901234567890."
}
```

**Response fields**

| Field              | Type                | Description                                                               |
| ------------------ | ------------------- | ------------------------------------------------------------------------- |
| `address`          | string              | Normalised (lower-case) Ethereum address                                  |
| `score`            | integer 0–100       | Computed trust score                                                      |
| `bondedAmount`     | string (bigint wei) | Amount bonded in wei                                                      |
| `bondStart`        | string \| null      | ISO 8601 timestamp when the bond was first posted                         |
| `attestationCount` | integer             | Number of on-chain attestations                                           |
| `agreedFields`     | object?             | Key/value pairs the identity has explicitly attested to (omitted if none) |

**cURL examples**

```bash
# Standard tier
curl http://localhost:3000/api/trust/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266

# Premium tier
curl -H "X-API-Key: my-key" \
  http://localhost:3000/api/trust/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266

# Not found (valid address, no record)
curl http://localhost:3000/api/trust/0x1234567890123456789012345678901234567890

# Invalid address format
curl http://localhost:3000/api/trust/not-an-address
```

---

### `GET /api/attestations/:address`

Returns persisted attestations for a subject address. Results are ordered newest
first and paginated with `page` and `limit`.

```
GET /api/attestations/:address?page=1&limit=20
```

**Response `200`**

```json
{
  "address": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "attestations": [
    {
      "id": 42,
      "bondId": 10,
      "attesterAddress": "0x2222222222222222222222222222222222222222",
      "subjectAddress": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      "score": 90,
      "note": "{\"key\":\"kyc\",\"value\":\"verified\"}",
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "offset": 0,
  "page": 1,
  "limit": 20,
  "total": 1,
  "hasNext": false
}
```

### `POST /api/attestations`

Creates a persisted attestation, invalidates attestation caches, and emits an
`attestation.created` outbox event.

```json
{
  "bondId": 10,
  "attesterAddress": "0x2222222222222222222222222222222222222222",
  "subject": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "key": "kyc",
  "value": "verified",
  "score": 90
}
```

**Responses**

| Status | Condition                                                      |
| ------ | -------------------------------------------------------------- |
| `201`  | Attestation persisted                                          |
| `400`  | Invalid address, score, pagination, or oversized `key`/`value` |
| `409`  | Duplicate `(bondId, attesterAddress, subject)` attestation     |

---

### `GET /api/bond/:address`

Returns bond status for an Ethereum address from the database.

```
GET /api/bond/:address
```

**Path parameters**

| Param     | Description                            |
| --------- | -------------------------------------- |
| `address` | Ethereum address (`0x` + 40 hex chars) |

**Headers (optional)**

| Header      | Description                   |
| ----------- | ----------------------------- |
| `X-API-Key` | API key for premium rate tier |

**Responses**

| Status | Condition                                    |
| ------ | -------------------------------------------- |
| `200`  | Bond record found; returns BondStatus object |
| `400`  | Address format invalid                       |
| `404`  | No bond record for this address              |

**`200` example — active bond**

```json
{
  "address": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "bondedAmount": "1000000000000000000",
  "bondStart": "2024-01-15T00:00:00.000Z",
  "bondDuration": 31536000,
  "active": true,
  "status": "active",
  "slashedAmount": "0"
}
```

**`200` example — inactive / no bond**

```json
{
  "address": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "bondedAmount": "0",
  "bondStart": null,
  "bondDuration": null,
  "active": false,
  "status": "inactive",
  "slashedAmount": "0"
}
```

**`400` example**

```json
{
  "error": "Invalid address format. Expected an Ethereum address: 0x followed by 40 hex characters."
}
```

**`404` example**

```json
{
  "error": "No bond record found for address 0x1234567890123456789012345678901234567890."
}
```

**Response fields**

| Field           | Type                | Description                          |
| --------------- | ------------------- | ------------------------------------ |
| `address`       | string              | Normalised lower-case address        |
| `bondedAmount`  | string (bigint wei) | Currently bonded amount              |
| `bondStart`     | string \| null      | ISO 8601 bond start timestamp        |
| `bondDuration`  | integer \| null     | Bond duration in seconds             |
| `active`        | boolean             | Whether the bond is currently active |
| `status`        | string              | Canonical derived bond status        |
| `slashedAmount` | string (bigint wei) | Total amount slashed from this bond  |

**cURL examples**

```bash
# Active bond
curl http://localhost:3000/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266

# Not found (valid address, no record)
curl http://localhost:3000/api/bond/0x1234567890123456789012345678901234567890

# Invalid address format
curl http://localhost:3000/api/bond/not-an-address
```

---

### Governance & disputes — authentication

All `/api/governance/*` and `/api/disputes/*` endpoints require a bearer
token issued via the API key flow.

```
Authorization: Bearer <api-key>
```

Requests without a valid token receive a `401`:

```json
{ "error": "Unauthorized", "message": "Bearer token required" }
```

---

### `POST /api/governance/slash-requests`

Opens a new slash request awaiting governance votes. Requests resolve to
`approved` once enough `approve` votes reach `threshold`, or to `rejected`
once a majority reject or the remaining voters can no longer reach
`threshold`.

**Body**

```json
{
  "targetAddress": "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX",
  "reason": "Repeated SLA violations on delivery commitments",
  "requestedBy": "validator-12",
  "threshold": 3,
  "totalSigners": 5
}
```

| Field           | Type   | Required | Description                                |
| --------------- | ------ | -------- | ------------------------------------------ |
| `targetAddress` | string | yes      | On-chain address of the entity being slashed |
| `reason`        | string | yes      | Reason for the slash request                |
| `requestedBy`   | string | yes      | Identifier of the requester                  |
| `threshold`     | number | no       | Approve votes required to pass (default `3`) |
| `totalSigners`  | number | no       | Total eligible signers (default `5`)         |

**Responses**

| Status | Condition                                                |
| ------ | --------------------------------------------------------- |
| `201`  | Slash request created; returns the `SlashRequest` object  |
| `400`  | `threshold < 1`, or `totalSigners < threshold`             |
| `401`  | Missing or invalid bearer token                           |

**`201` example**

```json
{
  "id": "a1b2c3d4e5f6a7b8",
  "targetAddress": "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX",
  "reason": "Repeated SLA violations on delivery commitments",
  "requestedBy": "validator-12",
  "createdAt": "2024-01-15T09:00:00.000Z",
  "votes": [],
  "status": "pending",
  "threshold": 3,
  "totalSigners": 5
}
```

---

### `GET /api/governance/slash-requests`

Lists slash requests, optionally filtered by status, with pagination.

```
GET /api/governance/slash-requests?status=pending&page=1&limit=20
```

**Query parameters**

| Param    | Type   | Description                                |
| -------- | ------ | ------------------------------------------- |
| `status` | string | Filter: `pending`, `approved`, or `rejected` |
| `page`   | number | Page number (default `1`)                   |
| `limit`  | number | Items per page (default `20`, max `100`)     |
| `offset` | number | Explicit offset (overrides `page`)           |

**Response `200`**

```json
{
  "success": true,
  "data": [ /* SlashRequest objects */ ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "hasNext": false
}
```

---

### `GET /api/governance/slash-requests/:id`

Returns a single slash request by ID.

**Responses**

| Status | Condition                                  |
| ------ | ------------------------------------------- |
| `200`  | Slash request found                         |
| `401`  | Missing or invalid bearer token             |
| `404`  | No slash request with this ID               |

---

### `POST /api/governance/slash-requests/:id/votes`

Casts an `approve`/`reject` vote on a pending slash request. Each voter may
vote at most once per request.

**Body**

```json
{ "voterId": "validator-3", "choice": "approve" }
```

| Field     | Type   | Required | Description               |
| --------- | ------ | -------- | -------------------------- |
| `voterId` | string | yes      | Identifier of the voter    |
| `choice`  | string | yes      | `approve` or `reject`      |

**Responses**

| Status | Condition                                                       |
| ------ | ---------------------------------------------------------------- |
| `201`  | Vote recorded; returns updated counts and status                 |
| `401`  | Missing or invalid bearer token                                  |
| `404`  | No slash request with this ID                                    |
| `409`  | Request is already resolved, or this voter has already voted     |

**`201` example**

```json
{
  "slashRequestId": "a1b2c3d4e5f6a7b8",
  "voterId": "validator-3",
  "choice": "approve",
  "approveCount": 2,
  "rejectCount": 0,
  "status": "pending"
}
```

---

### Dispute lifecycle

Disputes move through a fixed set of states:

```
pending ──┬─→ under_review ──┬─→ resolved
          │                  ├─→ dismissed
          │                  └─→ expired
          ├─→ resolved
          ├─→ dismissed
          └─→ expired
```

| Status         | Meaning                                                  |
| -------------- | --------------------------------------------------------- |
| `pending`      | Filed, awaiting review                                    |
| `under_review` | An arbiter has started reviewing the dispute               |
| `resolved`     | Closed with a resolution note                              |
| `dismissed`    | Closed without action, with a reason                       |
| `expired`      | Past its `deadline` without resolution                     |

Any request that attempts an invalid transition (e.g. resolving an
already-resolved dispute, or reviewing one that has expired) receives a
`422`:

```json
{
  "error": "Invalid dispute state transition",
  "code": "invalid_dispute_transition",
  "error_code": "invalid_dispute_transition",
  "message": "Invalid transition from \"resolved\" to \"resolved\""
}
```

---

### `POST /api/disputes`

Files a new dispute between two Stellar addresses with supporting evidence.

**Body**

```json
{
  "filedBy": "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX",
  "respondent": "GBVFLWXYZ6JJ7TUSU6QDJ6DOY4J5G5VHGJWSCMHL7QSAHRDEQU3EXFW2",
  "reason": "Goods delivered did not match the agreed specification",
  "evidence": ["ipfs://bafybeih..."],
  "deadlineMs": 86400000
}
```

| Field        | Type     | Required | Description                                                  |
| ------------ | -------- | -------- | -------------------------------------------------------------- |
| `filedBy`    | string   | yes      | Stellar address (`G...`) of the party filing the dispute       |
| `respondent` | string   | yes      | Stellar address (`G...`) of the respondent; must differ from `filedBy` |
| `reason`     | string   | yes      | At least 10 characters                                         |
| `evidence`   | string[] | yes      | At least one evidence reference                                 |
| `deadlineMs` | number   | yes      | Resolution deadline from now, in ms (min 1 hour, max 30 days)   |

**Responses**

| Status | Condition                                                                     |
| ------ | ------------------------------------------------------------------------------ |
| `201`  | Dispute submitted; returns the `Dispute` object                                |
| `400`  | Invalid Stellar address, `filedBy === respondent`, reason too short, missing evidence, or deadline out of range |
| `401`  | Missing or invalid bearer token                                                |

**`201` example**

```json
{
  "id": "5f8d0d55-1c1b-4e9a-9b1a-4e6f6f6f6f6f",
  "filedBy": "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX",
  "respondent": "GBVFLWXYZ6JJ7TUSU6QDJ6DOY4J5G5VHGJWSCMHL7QSAHRDEQU3EXFW2",
  "reason": "Goods delivered did not match the agreed specification",
  "evidence": ["ipfs://bafybeih..."],
  "status": "pending",
  "createdAt": "2024-01-15T09:00:00.000Z",
  "deadline": "2024-01-16T09:00:00.000Z",
  "resolution": null
}
```

---

### `GET /api/disputes/:id`

Returns a single dispute by ID.

**Responses**

| Status | Condition                        |
| ------ | --------------------------------- |
| `200`  | Dispute found                     |
| `401`  | Missing or invalid bearer token   |
| `404`  | No dispute with this ID           |

---

### `POST /api/disputes/:id/review`

Transitions a `pending` dispute to `under_review`.

**Responses**

| Status | Condition                                          |
| ------ | --------------------------------------------------- |
| `200`  | Dispute marked under review                         |
| `401`  | Missing or invalid bearer token                     |
| `422`  | Invalid transition (see [dispute lifecycle](#dispute-lifecycle)) |

---

### `POST /api/disputes/:id/resolve`

Transitions a `pending` or `under_review` dispute to `resolved`.

**Body**

```json
{ "resolution": "Respondent agreed to a partial refund of 20%" }
```

**Responses**

| Status | Condition                                                          |
| ------ | -------------------------------------------------------------------- |
| `200`  | Dispute resolved                                                      |
| `401`  | Missing or invalid bearer token                                      |
| `422`  | Invalid transition, missing `resolution`, or the dispute has expired |

---

### `POST /api/disputes/:id/dismiss`

Transitions a `pending` or `under_review` dispute to `dismissed`.

**Body**

```json
{ "reason": "Insufficient evidence provided" }
```

**Responses**

| Status | Condition                                            |
| ------ | ------------------------------------------------------ |
| `200`  | Dispute dismissed                                       |
| `401`  | Missing or invalid bearer token                         |
| `422`  | Invalid transition or missing `reason`                  |

---

### `WebSocket /api/ws/subscribe/:identity`

Subscribe to real-time trust-score change notifications for a given identity via WebSocket.

```
WebSocket ws://localhost:3000/api/ws/subscribe/:identity?key=<api-key>
Authorization: Bearer <api-key>
```

**Protocol**

The WebSocket endpoint streams JSON-formatted score update messages to authenticated subscribers. Connections are per-identity; each client receives updates for one specific identity.

**Connection parameters**

| Parameter  | Type   | Description                                         |
| ---------- | ------ | --------------------------------------------------- |
| `identity` | string | Identity address to watch (normalized to lowercase) |

**Authentication**

Provide an API key via **one** of:

1. Query parameter: `?key=<api-key>`
2. Authorization header: `Authorization: Bearer <api-key>`

The API key must be valid and active; subscription requests with invalid keys are rejected at the handshake phase.

**Message types**

##### `subscribe_success`

Sent immediately after connection to confirm the subscription.

```json
{
  "type": "subscribe_success",
  "data": {
    "identity": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "message": "Subscribed to trust score updates for 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
  },
  "timestamp": 1717224654321
}
```

##### `score_update`

Sent when a trust score changes. Contains the new score and timestamp.

```json
{
  "type": "score_update",
  "data": {
    "identity": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "score": 85,
    "timestamp": 1717224700000
  },
  "timestamp": 1717224700123
}
```

##### `rate_limit`

Sent when the per-connection message rate limit is exceeded (default: 100 messages/sec).

```json
{
  "type": "rate_limit",
  "error": "Rate limit exceeded: 100 messages per second",
  "timestamp": 1717224701000
}
```

##### `error`

Sent on subscription or connection errors.

```json
{
  "type": "error",
  "error": "Subscription failed: invalid identity",
  "timestamp": 1717224651000
}
```

**Rate limiting**

- **Per-connection limit:** 100 messages per second (configurable)
- **Backpressure threshold:** 1 MB buffered (connections dropping messages when slow clients can't keep up)
- **Timeout:** None (server-initiated close only on graceful shutdown)

**Graceful shutdown**

When the server shuts down, all connected clients receive a close frame with code `1000` (normal closure) and message "Server shutting down gracefully". Clients have up to 5 seconds to close before connections are forcibly terminated.

**Error codes**

| HTTP status | WebSocket close code | Reason                                   |
| ----------- | -------------------- | ---------------------------------------- |
| `401`       | `1008` (policy viol) | Invalid or missing API key               |
| `400`       | `1008` (policy viol) | Invalid identity format                  |
| `503`       | `1011` (server err)  | Subscription limit exceeded for identity |

**Example: Node.js client**

```javascript
const ws = new WebSocket(
  "ws://localhost:3000/api/ws/subscribe/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  {
    headers: {
      Authorization: "Bearer your-api-key-here",
    },
  },
);

ws.on("message", (data) => {
  const message = JSON.parse(data);

  if (message.type === "score_update") {
    console.log(
      `New score: ${message.data.score} at ${new Date(message.data.timestamp)}`,
    );
  } else if (message.type === "rate_limit") {
    console.warn("Rate limit hit, slowing down consumption");
  } else if (message.type === "error") {
    console.error(`Subscription error: ${message.error}`);
  }
});

ws.on("close", (code, reason) => {
  if (code === 1000) {
    console.log("Connection closed gracefully:", reason);
  } else {
    console.error(`Connection closed unexpectedly (${code}): ${reason}`);
  }
});
```

**Example: JavaScript (browser)**

```javascript
const identity = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const apiKey = "your-api-key-here";

const ws = new WebSocket(
  `wss://api.credence.example.com/api/ws/subscribe/${identity}?key=${apiKey}`,
);

ws.addEventListener("open", () => {
  console.log("Subscribed to score updates");
});

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  console.log("Score update:", message.data);
});

ws.addEventListener("close", () => {
  console.log("Connection closed");
});
```

**cURL / wscat example**

```bash
# Install wscat if not already installed
npm install -g wscat

# Subscribe and listen for messages
wscat -c "ws://localhost:3000/api/ws/subscribe/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266?key=your-api-key-here"

# Or use curl with Authorization header (for initial connection only)
curl -i -N \
  -H "Authorization: Bearer your-api-key-here" \
  ws://localhost:3000/api/ws/subscribe/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
```

---

### `GET /api/disputes`

Returns persisted disputes for the authenticated caller's tenant. Results are ordered newest first and paginated with cursor limit.

```
GET /api/disputes?status=pending&limit=20
```

**Query parameters**

| Parameter | Type   | Description                                                               |
| --------- | ------ | ------------------------------------------------------------------------- |
| `status`  | string | (Optional) Filter by dispute status (e.g. `pending`, `under_review`, etc) |
| `limit`   | int    | (Optional) Number of results to return (default 20, max 100)              |
| `cursor`  | string | (Optional) Pagination cursor                                              |

**Response `200`**

```json
{
  "data": [
    {
      "id": "abc-123",
      "filedBy": "0x222...",
      "respondent": "0x333...",
      "reason": "failure to deliver",
      "evidence": ["tx:abc"],
      "status": "pending",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "deadline": "2024-01-08T00:00:00.000Z",
      "resolution": null
    }
  ],
  "page": {
    "nextCursor": "base64encodedcursor_abc123",
    "hasMore": true,
    "limit": 20
  }
}
```

---

## Rate limiting

All `/api/*` routes are rate-limited using fixed-window counters stored in Redis.
Two independent counters are checked per request:

| Counter       | Scope          | Purpose                                                              |
| ------------- | -------------- | -------------------------------------------------------------------- |
| Tenant bucket | Per owner / IP | Enforces the tier ceiling shared across all keys of the same owner   |
| Key bucket    | Per API key id | Prevents a single noisy key from exhausting the shared tenant budget |

A request is rejected when **either** counter exceeds the limit.

### Tiers

| Tier         | Default limit (per window) |
| ------------ | -------------------------- |
| `free`       | 100 requests / 60 s        |
| `pro`        | 1 000 requests / 60 s      |
| `enterprise` | 10 000 requests / 60 s     |

Limits are configurable via environment variables (see [Environment Variables](../README.md#environment-variables)).

### Response headers

Every response includes:

| Header                  | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `X-RateLimit-Limit`     | Maximum requests allowed in the current window       |
| `X-RateLimit-Remaining` | Requests remaining (tighter of tenant vs key budget) |
| `X-RateLimit-Reset`     | Unix timestamp when the window resets                |
| `Retry-After`           | Seconds to wait before retrying (only on `429`)      |

### Error response (`429`)

```json
{
  "error": "Rate limit exceeded. Try again later.",
  "code": "rate_limit_exceeded",
  "details": { "retryAfter": 42, "limit": 100, "windowSec": 60 }
}
```

### Redis unavailability

Behaviour when Redis is unreachable is controlled by `RATE_LIMIT_FAIL_OPEN`:

| `RATE_LIMIT_FAIL_OPEN`          | Behaviour                                       |
| ------------------------------- | ----------------------------------------------- |
| `false` (default in production) | Returns `503 Service Unavailable` — fail-closed |
| `true` (default in dev/test)    | Passes the request through — fail-open          |

---

## Error format

All errors follow this shape:

```json
{ "error": "Human-readable description of what went wrong." }
```

---

## Importing the Postman collection

### Option A – Postman desktop / web

1. Open **Postman** and go to **Import** (top-left or File → Import).
2. Select **File** and choose `docs/credence.postman_collection.json`.
3. Click **Import**.
4. The **Credence API** collection appears in the left sidebar.

**Set environment variables:**

The collection ships with built-in variables. Edit them via the
collection's **Variables** tab (click the collection name → Variables):

| Variable          | Default                 | Change to                                                |
| ----------------- | ----------------------- | --------------------------------------------------------- |
| `baseUrl`         | `http://localhost:3000` | Your staging/production URL                                |
| `apiKey`          | _(empty)_               | Your API key (leave blank for standard tier)                |
| `address`         | `0xf39fd...2266`        | Any valid address you want to query                         |
| `bearerToken`     | _(empty)_               | API key for `Authorization: Bearer` — required by Governance/Disputes requests |
| `slashRequestId`  | `a1b2c3d4e5f6a7b8`      | A slash request ID returned from "Create slash request"     |
| `disputeId`       | `5f8d0d55-...`          | A dispute ID returned from "Submit dispute"                  |

### Option B – Insomnia

Insomnia can import Postman v2.1 collections directly:

1. Open **Insomnia** and go to **File → Import**.
2. Select `docs/credence.postman_collection.json`.
3. Choose **Import as: Request Collection**.
4. Click **Import**.

After importing, set `baseUrl` and `apiKey` in your active environment
(**Manage Environments → Base Environment**).

### Option C – Newman (CLI runner)

Run the full collection from the terminal without the Postman desktop app:

```bash
# Install Newman globally
npm install -g newman

# Run the collection
newman run docs/credence.postman_collection.json \
  --env-var "baseUrl=http://localhost:3000" \
  --env-var "apiKey=your-key-here"
```

---

## Viewing the OpenAPI spec

The spec at `docs/openapi.yaml` is valid OpenAPI 3.1.0 and can be rendered
by any compatible tool:

```bash
# Swagger UI via npx (no install required)
npx @redocly/cli preview-docs docs/openapi.yaml

# Or with Stoplight Prism (mock server + validation)
npx @stoplight/prism-cli mock docs/openapi.yaml
```

"Alternatively, paste the file contents into [editor.swagger.io](https://editor.swagger.io) or [readme.com](https://readme.com).

---

## OpenAPI Contract Drift Gate (CI)

A mandatory CI gate (`npm run test:openapi-drift`) prevents silent drift between the published OpenAPI contract and runtime Express routes.

### How it works
- The introspector walks the router tree defined in `src/app.ts`.
- It extracts paths, HTTP methods, and references to Zod schemas from `src/schemas/`.
- It compares the result against `docs/openapi.yaml`.
- The job **fails** on:
  - Added or removed routes
  - Incompatible schema shape changes
- **Security**: Internal-only routes under `src/routes/admin/` are explicitly excluded from the public contract.

### Regenerating the spec deterministically
```bash
npm run generate:openapi
```
This command produces a fresh `docs/openapi.yaml` from the current Zod schemas. After regeneration, run the drift check to confirm parity:

```bash
npm run test:openapi-drift
```

### Running locally
```bash
npm run test:openapi-drift
```

The gate is also executed automatically in CI on every push and pull request.
