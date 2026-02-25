# Bulk Identity Verification API

## Overview

The Bulk Identity Verification endpoint allows enterprise-tier clients to verify multiple Stellar addresses in a single request, retrieving trust scores and bond status for each address efficiently.

## Endpoint

```
POST /api/bulk/verify
```

## Authentication

This endpoint requires an Enterprise-tier API key.

### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `X-API-Key` | Yes | Enterprise API key |
| `Content-Type` | Yes | Must be `application/json` |

## Request

### Request Body

```json
{
  "addresses": ["string[]"]
}
```

### Parameters

| Field | Type | Required | Description | Constraints |
|-------|------|----------|-------------|-------------|
| `addresses` | string[] | Yes | Array of Stellar addresses to verify | Min: 1, Max: 100 |

### Constraints

- Minimum batch size: 1 address
- Maximum batch size: 100 addresses
- All addresses must be valid strings
- Duplicate addresses are automatically deduplicated
- Each address must be a valid Stellar address format (56 characters, starting with 'G')

## Response

### Success Response (200 OK)

```json
{
  "results": [
    {
      "address": "GABC...",
      "trustScore": 85,
      "bondStatus": {
        "bondedAmount": "5000.00",
        "bondStart": "2024-01-15T10:30:00.000Z",
        "bondDuration": 365,
        "active": true
      },
      "attestationCount": 12,
      "lastUpdated": "2024-02-24T10:30:00.000Z"
    }
  ],
  "errors": [
    {
      "address": "INVALID",
      "error": "VerificationFailed",
      "message": "Invalid Stellar address format"
    }
  ],
  "metadata": {
    "totalRequested": 2,
    "successful": 1,
    "failed": 1,
    "batchSize": 2
  }
}
```

### Response Fields

#### Results Array

Each successful verification contains:

| Field | Type | Description |
|-------|------|-------------|
| `address` | string | The verified Stellar address |
| `trustScore` | number | Trust score (0-100) |
| `bondStatus` | object | Bond status information |
| `bondStatus.bondedAmount` | string | Amount bonded (as string for precision) |
| `bondStatus.bondStart` | string \| null | ISO timestamp of bond start |
| `bondStatus.bondDuration` | number \| null | Bond duration in days |
| `bondStatus.active` | boolean | Whether bond is currently active |
| `attestationCount` | number | Number of attestations |
| `lastUpdated` | string | ISO timestamp of last update |

#### Errors Array

Each failed verification contains:

| Field | Type | Description |
|-------|------|-------------|
| `address` | string | The address that failed verification |
| `error` | string | Error code |
| `message` | string | Human-readable error message |

#### Metadata Object

| Field | Type | Description |
|-------|------|-------------|
| `totalRequested` | number | Total addresses in request (including duplicates) |
| `successful` | number | Number of successful verifications |
| `failed` | number | Number of failed verifications |
| `batchSize` | number | Number of unique addresses processed |

## Error Responses

### 400 Bad Request

Invalid request format or parameters.

```json
{
  "error": "InvalidRequest",
  "message": "addresses must be an array"
}
```

```json
{
  "error": "BatchSizeTooSmall",
  "message": "Minimum batch size is 1 address",
  "limit": 1,
  "received": 0
}
```

### 401 Unauthorized

Missing or invalid API key.

```json
{
  "error": "Unauthorized",
  "message": "API key is required"
}
```

```json
{
  "error": "Unauthorized",
  "message": "Invalid API key"
}
```

### 403 Forbidden

Insufficient API key scope.

```json
{
  "error": "Forbidden",
  "message": "Enterprise API key required"
}
```

### 413 Payload Too Large

Batch size exceeds maximum limit.

```json
{
  "error": "BatchSizeExceeded",
  "message": "Maximum batch size is 100 addresses",
  "limit": 100,
  "received": 150
}
```

### 500 Internal Server Error

Unexpected server error.

```json
{
  "error": "InternalServerError",
  "message": "An unexpected error occurred during bulk verification"
}
```

## Examples

### Example 1: Verify Multiple Valid Addresses

**Request:**

```bash
curl -X POST http://localhost:3000/api/bulk/verify \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-enterprise-key-12345" \
  -d '{
    "addresses": [
      "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
      "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ"
    ]
  }'
```

**Response:**

```json
{
  "results": [
    {
      "address": "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
      "trustScore": 85,
      "bondStatus": {
        "bondedAmount": "5000.00",
        "bondStart": "2024-01-15T10:30:00.000Z",
        "bondDuration": 365,
        "active": true
      },
      "attestationCount": 12,
      "lastUpdated": "2024-02-24T10:30:00.000Z"
    },
    {
      "address": "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
      "trustScore": 42,
      "bondStatus": {
        "bondedAmount": "0",
        "bondStart": null,
        "bondDuration": null,
        "active": false
      },
      "attestationCount": 3,
      "lastUpdated": "2024-02-24T10:30:00.000Z"
    }
  ],
  "errors": [],
  "metadata": {
    "totalRequested": 2,
    "successful": 2,
    "failed": 0,
    "batchSize": 2
  }
}
```

### Example 2: Partial Failure

**Request:**

```bash
curl -X POST http://localhost:3000/api/bulk/verify \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-enterprise-key-12345" \
  -d '{
    "addresses": [
      "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
      "INVALID_ADDRESS",
      "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ"
    ]
  }'
```

**Response:**

```json
{
  "results": [
    {
      "address": "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
      "trustScore": 85,
      "bondStatus": {
        "bondedAmount": "5000.00",
        "bondStart": "2024-01-15T10:30:00.000Z",
        "bondDuration": 365,
        "active": true
      },
      "attestationCount": 12,
      "lastUpdated": "2024-02-24T10:30:00.000Z"
    },
    {
      "address": "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
      "trustScore": 42,
      "bondStatus": {
        "bondedAmount": "0",
        "bondStart": null,
        "bondDuration": null,
        "active": false
      },
      "attestationCount": 3,
      "lastUpdated": "2024-02-24T10:30:00.000Z"
    }
  ],
  "errors": [
    {
      "address": "INVALID_ADDRESS",
      "error": "VerificationFailed",
      "message": "Invalid Stellar address format"
    }
  ],
  "metadata": {
    "totalRequested": 3,
    "successful": 2,
    "failed": 1,
    "batchSize": 3
  }
}
```

### Example 3: Authentication Error

**Request:**

```bash
curl -X POST http://localhost:3000/api/bulk/verify \
  -H "Content-Type: application/json" \
  -d '{
    "addresses": ["GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ"]
  }'
```

**Response:**

```json
{
  "error": "Unauthorized",
  "message": "API key is required"
}
```

## Rate Limiting

Currently, rate limiting is not implemented. In production, consider implementing:

- Per-API-key rate limits
- Per-IP rate limits
- Sliding window or token bucket algorithms
- Redis-based distributed rate limiting

## Best Practices

1. **Batch Size**: Use the maximum batch size (100) for optimal performance
2. **Error Handling**: Always check both `results` and `errors` arrays
3. **Deduplication**: The API automatically deduplicates addresses, but avoid sending duplicates
4. **Retry Logic**: Implement exponential backoff for failed requests
5. **Partial Failures**: Process successful results even when some addresses fail
6. **API Key Security**: Never expose API keys in client-side code or version control

## Performance Considerations

- Addresses are processed in parallel for optimal performance
- Average response time: ~50-100ms for batches up to 100 addresses
- Network latency will vary based on client location

## Future Enhancements

- WebSocket support for real-time updates
- Pagination for larger batches
- Filtering and sorting options
- Caching layer for frequently queried addresses
- Rate limiting implementation
- Webhook notifications for status changes
