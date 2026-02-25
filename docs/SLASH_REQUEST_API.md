## Slash Request API Documentation

### Overview

The Slash Request API provides endpoints for managing slash requests in the Credence governance system. Slash requests allow verifiers to propose slashing malicious actors' bonds.

### Base URL

```
http://localhost:3000/api/slash
```

### Authentication

All endpoints require an Enterprise API key via the `X-API-Key` header.

```
X-API-Key: your-enterprise-key
```

---

## Endpoints

### 1. Submit Slash Request

Submit a new slash request against a malicious actor.

**Endpoint:** `POST /api/slash/submit`

**Authorization:** Enterprise API key required

**Request Body:**

```json
{
  "targetAddress": "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
  "amount": "100.5",
  "reason": "Malicious behavior detected: submitted false attestations repeatedly",
  "evidenceRef": "https://evidence.example.com/case-123",
  "submittedBy": "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ"
}
```

**Request Fields:**

| Field | Type | Required | Description | Constraints |
|-------|------|----------|-------------|-------------|
| `targetAddress` | string | Yes | Stellar address to slash | Valid Stellar address (G + 55 base32 chars) |
| `amount` | string | Yes | Amount to slash (XLM) | > 0.0000001, ≤ 1,000,000,000 |
| `reason` | string | Yes | Detailed reason | 10-5000 characters |
| `evidenceRef` | string | Yes | Evidence reference | URL, IPFS hash, or other reference |
| `submittedBy` | string | Yes | Submitter's Stellar address | Valid Stellar address, must be verifier |

**Response (201 Created):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "targetAddress": "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
  "amount": "100.5",
  "reason": "Malicious behavior detected: submitted false attestations repeatedly",
  "evidenceRef": "https://evidence.example.com/case-123",
  "status": "pending",
  "submittedBy": "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
  "submittedAt": "2024-02-25T10:30:00.000Z",
  "reviewedBy": null,
  "reviewedAt": null,
  "reviewNotes": null,
  "executedAt": null,
  "executionTxHash": null,
  "createdAt": "2024-02-25T10:30:00.000Z",
  "updatedAt": "2024-02-25T10:30:00.000Z"
}
```

**Error Responses:**

- `400 Bad Request` - Validation error
- `401 Unauthorized` - Missing or invalid API key
- `403 Forbidden` - Insufficient permissions
- `500 Internal Server Error` - Server error

---

### 2. List Slash Requests

List slash requests with optional filters and pagination.

**Endpoint:** `GET /api/slash/list`

**Authorization:** Enterprise API key required

**Query Parameters:**

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `status` | string | No | Filter by status | All statuses |
| `targetAddress` | string | No | Filter by target address | All addresses |
| `submittedBy` | string | No | Filter by submitter | All submitters |
| `limit` | number | No | Results per page | 50 (max 100) |
| `offset` | number | No | Pagination offset | 0 |

**Status Values:**
- `pending` - Awaiting review
- `approved` - Approved for execution
- `rejected` - Rejected by reviewer
- `executed` - Successfully executed on-chain

**Example Request:**

```bash
GET /api/slash/list?status=pending&limit=20&offset=0
```

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "targetAddress": "GABC...",
      "amount": "100.5",
      "reason": "Malicious behavior...",
      "evidenceRef": "https://evidence.example.com/case-123",
      "status": "pending",
      "submittedBy": "GDEF...",
      "submittedAt": "2024-02-25T10:30:00.000Z",
      "reviewedBy": null,
      "reviewedAt": null,
      "reviewNotes": null,
      "executedAt": null,
      "executionTxHash": null,
      "createdAt": "2024-02-25T10:30:00.000Z",
      "updatedAt": "2024-02-25T10:30:00.000Z"
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

---

### 3. Get Slash Request by ID

Retrieve a specific slash request by its UUID.

**Endpoint:** `GET /api/slash/:id`

**Authorization:** Enterprise API key required

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Slash request ID |

**Example Request:**

```bash
GET /api/slash/550e8400-e29b-41d4-a716-446655440000
```

**Response (200 OK):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "targetAddress": "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
  "amount": "100.5",
  "reason": "Malicious behavior detected...",
  "evidenceRef": "https://evidence.example.com/case-123",
  "status": "approved",
  "submittedBy": "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
  "submittedAt": "2024-02-25T10:30:00.000Z",
  "reviewedBy": "GHIJ7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
  "reviewedAt": "2024-02-25T11:00:00.000Z",
  "reviewNotes": "Evidence verified, approved for execution",
  "executedAt": null,
  "executionTxHash": null,
  "createdAt": "2024-02-25T10:30:00.000Z",
  "updatedAt": "2024-02-25T11:00:00.000Z"
}
```

**Error Responses:**

- `404 Not Found` - Slash request not found

---

### 4. Review Slash Request

Approve or reject a pending slash request.

**Endpoint:** `POST /api/slash/:id/review`

**Authorization:** Enterprise API key required (admin/reviewer role)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Slash request ID |

**Request Body:**

```json
{
  "status": "approved",
  "reviewedBy": "GHIJ7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
  "reviewNotes": "Evidence verified, approved for execution"
}
```

**Request Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | Yes | `approved` or `rejected` |
| `reviewedBy` | string | Yes | Reviewer's Stellar address |
| `reviewNotes` | string | No | Optional review notes |

**Response (200 OK):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "targetAddress": "GABC...",
  "amount": "100.5",
  "status": "approved",
  "reviewedBy": "GHIJ...",
  "reviewedAt": "2024-02-25T11:00:00.000Z",
  "reviewNotes": "Evidence verified, approved for execution",
  ...
}
```

**Error Responses:**

- `400 Bad Request` - Invalid status or transition
- `404 Not Found` - Slash request not found

---

### 5. Execute Slash Request

Execute an approved slash request on-chain.

**Endpoint:** `POST /api/slash/:id/execute`

**Authorization:** Enterprise API key required (admin role)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Slash request ID |

**Request Body:**

```json
{
  "executionTxHash": "abc123def456789..."
}
```

**Request Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `executionTxHash` | string | Yes | Transaction hash of the execution |

**Response (200 OK):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "targetAddress": "GABC...",
  "amount": "100.5",
  "status": "executed",
  "executedAt": "2024-02-25T12:00:00.000Z",
  "executionTxHash": "abc123def456789...",
  ...
}
```

**Error Responses:**

- `400 Bad Request` - Request not approved or missing tx hash
- `404 Not Found` - Slash request not found

---

## Status Workflow

```
pending → approved → executed
        ↘ rejected
```

**Valid Transitions:**

| From | To | Description |
|------|-----|-------------|
| `pending` | `approved` | Reviewer approves the request |
| `pending` | `rejected` | Reviewer rejects the request |
| `approved` | `executed` | Admin executes the slash on-chain |

**Invalid Transitions:**

- Cannot transition from `rejected` or `executed`
- Cannot skip `approved` state (pending → executed)
- Cannot reverse decisions

---

## Database Schema

```sql
CREATE TABLE slash_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_address VARCHAR(56) NOT NULL,
  amount DECIMAL(20, 7) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (LENGTH(reason) >= 10),
  evidence_ref TEXT NOT NULL,
  status slash_status NOT NULL DEFAULT 'pending',
  submitted_by VARCHAR(56) NOT NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_by VARCHAR(56),
  reviewed_at TIMESTAMP,
  review_notes TEXT,
  executed_at TIMESTAMP,
  execution_tx_hash VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**Indexes:**

- `idx_slash_requests_status` - Query by status
- `idx_slash_requests_target` - Query by target address
- `idx_slash_requests_submitter` - Query by submitter
- `idx_slash_requests_created_at` - Sort by creation date

---

## Example Usage

### Complete Workflow Example

```bash
# 1. Submit a slash request
curl -X POST http://localhost:3000/api/slash/submit \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-enterprise-key" \
  -d '{
    "targetAddress": "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
    "amount": "100.5",
    "reason": "Submitted false attestations repeatedly over 30 days",
    "evidenceRef": "https://evidence.example.com/case-123",
    "submittedBy": "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ"
  }'

# 2. List pending requests
curl -X GET "http://localhost:3000/api/slash/list?status=pending" \
  -H "X-API-Key: your-enterprise-key"

# 3. Get specific request
curl -X GET http://localhost:3000/api/slash/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: your-enterprise-key"

# 4. Review and approve
curl -X POST http://localhost:3000/api/slash/550e8400-e29b-41d4-a716-446655440000/review \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-enterprise-key" \
  -d '{
    "status": "approved",
    "reviewedBy": "GHIJ7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
    "reviewNotes": "Evidence verified, approved for execution"
  }'

# 5. Execute on-chain
curl -X POST http://localhost:3000/api/slash/550e8400-e29b-41d4-a716-446655440000/execute \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-enterprise-key" \
  -d '{
    "executionTxHash": "abc123def456789..."
  }'
```

---

## Best Practices

1. **Evidence**: Always provide detailed, verifiable evidence
2. **Reason**: Be specific and include dates, transaction hashes, or other proof
3. **Review**: Have multiple reviewers verify evidence before approval
4. **Execution**: Verify on-chain execution before marking as executed
5. **Monitoring**: Track slash requests for patterns of abuse

---

## Error Handling

All errors follow a consistent format:

```json
{
  "error": "ErrorType",
  "message": "Human-readable error message"
}
```

**Common Error Types:**

- `ValidationError` - Input validation failed
- `NotFound` - Resource not found
- `InvalidStatusTransition` - Invalid status change
- `Unauthorized` - Missing or invalid API key
- `Forbidden` - Insufficient permissions
- `InternalServerError` - Server error

---

## Security Considerations

1. **API Keys**: Store securely, rotate regularly
2. **Role-Based Access**: Implement verifier/admin roles
3. **Audit Trail**: All actions are timestamped and attributed
4. **Evidence Verification**: Verify evidence before approval
5. **Rate Limiting**: Implement to prevent abuse
6. **Input Validation**: All inputs are validated server-side

---

## Testing

Run the test suite:

```bash
npm test src/services/slash
npm test src/routes/slash.test.ts
```

Test coverage: >95% for all slash-related code.
