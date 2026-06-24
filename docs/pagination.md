# Cursor-Based Pagination Guide

## Overview

This API uses **opaque cursor-based pagination** for list endpoints to ensure consistent, scalable pagination that works correctly even with concurrent data modifications.

## Why Cursor-Based Pagination?

- **Offset-based pagination** can skip or duplicate rows when data is inserted/deleted concurrently
- **Cursor-based pagination** provides a stable, opaque reference point that survives concurrent modifications
- **Cursors are stateless** - the server doesn't need to track pagination state

## Pagination Envelope

All paginated endpoints return a standardized envelope:

```json
{
  "data": [/* array of items */],
  "page": {
    "nextCursor": "eyJ0IjoiMjAyNC0wMS0xNVQxMDozMDowMC4wMDBaIiwiaCI6IjEyMyJ9",
    "hasMore": true,
    "limit": 20
  }
}
```

### Envelope Fields

- **data** (`T[]`): The actual paginated results
- **page.nextCursor** (`string | null`): Opaque cursor for fetching the next page (null if no more pages)
- **page.hasMore** (`boolean`): Whether more results are available
- **page.limit** (`number`): The requested page size

## Request Parameters

All paginated endpoints accept these query parameters:

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `limit` | integer | 20 | 100 | Number of results per page |
| `cursor` | string | null | - | Opaque cursor from previous `page.nextCursor` response |

## Examples

### Initial Request

```bash
GET /api/attestations/0xsubject?limit=20
```

Response:
```json
{
  "data": [
    { "id": 1, "score": 100, "createdAt": "2024-01-15T10:30:00Z" },
    { "id": 2, "score": 95, "createdAt": "2024-01-15T10:25:00Z" }
  ],
  "page": {
    "nextCursor": "eyJ0IjoiMjAyNC0wMS0xNVQxMDoyNTowMC4wMDBaIiwiaCI6IjIifQ",
    "hasMore": true,
    "limit": 20
  }
}
```

### Subsequent Request (Using Cursor)

```bash
GET /api/attestations/0xsubject?cursor=eyJ0IjoiMjAyNC0wMS0xNVQxMDoyNTowMC4wMDBaIiwiaCI6IjIifQ&limit=20
```

This fetches the next page starting after the item from the previous response.

### Last Page

When there are no more results:

```json
{
  "data": [
    { "id": 499, "score": 50, "createdAt": "2024-01-01T01:00:00Z" }
  ],
  "page": {
    "nextCursor": null,
    "hasMore": false,
    "limit": 20
  }
}
```

## Stable Sorting Guarantees

All list endpoints use stable sort by `(created_at DESC, id DESC)`:

- **Primary sort**: `created_at` descending (newest first)
- **Secondary sort**: `id` descending (within same timestamp, higher IDs first)

This ensures:
- Deterministic ordering regardless of concurrent inserts/deletes
- No duplicate results across pages
- No skipped results even if deletions occur

## Cursor Encoding

Cursors are base64url-encoded JSON objects containing:

```json
{
  "t": "2024-01-15T10:30:00.000Z",  // ISO 8601 timestamp of the sort key
  "i": "123"                         // String ID of the item
}
```

They are **opaque** - clients should not attempt to decode or construct them. Only use cursors returned from the API.

## Error Handling

### Invalid Cursor

```bash
GET /api/attestations/0xsubject?cursor=invalid-cursor
```

Response:
```json
{
  "error": "Validation failed",
  "code": "VALIDATION_FAILED",
  "details": [
    { "path": "cursor", "message": "Invalid cursor format" }
  ]
}
```

### Limit Too High

```bash
GET /api/attestations/0xsubject?limit=150
```

Response:
```json
{
  "error": "Validation failed",
  "code": "VALIDATION_FAILED",
  "details": [
    { "path": "limit", "message": "Limit must be at most 100" }
  ]
}
```

### Invalid Limit

```bash
GET /api/attestations/0xsubject?limit=abc
```

Response:
```json
{
  "error": "Validation failed",
  "code": "VALIDATION_FAILED",
  "details": [
    { "path": "limit", "message": "Expected an integer" }
  ]
}
```

## Client Implementation

### Pseudocode for Fetching All Pages

```javascript
async function fetchAllPages(address) {
  let cursor = null
  const allItems = []

  do {
    const url = new URL(`/api/attestations/${address}`)
    if (cursor) {
      url.searchParams.set('cursor', cursor)
    }

    const response = await fetch(url)
    const { data, page } = await response.json()

    allItems.push(...data)

    if (page.hasMore) {
      cursor = page.nextCursor
    } else {
      break
    }
  } while (true)

  return allItems
}
```

### React Hook Example

```typescript
function useAttestations(address: string) {
  const [items, setItems] = useState([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)

  const loadMore = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (cursor) params.set('cursor', cursor)
      
      const response = await fetch(`/api/attestations/${address}?${params}`)
      const { data, page } = await response.json()
      
      setItems(prev => [...prev, ...data])
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } finally {
      setLoading(false)
    }
  }, [address, cursor])

  return { items, hasMore, loading, loadMore }
}
```

## Pagination Performance

- **Initial request**: Fast - fetches limit + 1 rows to determine `hasMore`
- **Subsequent requests**: O(limit) - cursor enables keyset pagination
- **No total count**: We don't compute total results (expensive on large datasets)
- **Deep pagination**: No performance degradation regardless of page depth

## Backward Compatibility

These endpoints previously used offset-based pagination. The new cursor-based pagination is **not backward compatible** with old offset parameters:

### Old Response Format (No Longer Used)
```json
{
  "address": "0xsubject",
  "attestations": [...],
  "offset": 0,
  "page": 1,
  "limit": 20,
  "total": 500,
  "hasNext": true
}
```

### New Response Format
```json
{
  "address": "0xsubject",
  "data": [...],
  "page": {
    "nextCursor": "...",
    "hasMore": true,
    "limit": 20
  }
}
```

Clients must be updated to use `data` instead of `attestations` and the new `page` structure.

## Endpoints Using Cursor Pagination

- `GET /api/attestations/:address` - List attestations for an address
- `GET /api/transactions/history` - List transaction history

## Troubleshooting

### "Invalid cursor format"

**Cause**: Cursor was corrupted or tampered with.

**Solution**: Start from the first page (omit `cursor` parameter).

### "Limit must be at most 100"

**Cause**: Requested page size exceeds the maximum.

**Solution**: Use `limit=100` or smaller.

### Duplicate results across pages

**Cause**: Rare edge case if server time goes backward.

**Solution**: Retry the request. If persistent, contact support.

### Missing results between pages

**Cause**: Items were deleted after you fetched the first page.

**Expected behavior**: This is normal with concurrent deletions. The cursor ensures you don't see duplicates, but deleted items won't appear in subsequent pages.

## API Reference

### GET /api/attestations/:address

List attestations for an address with cursor-based pagination.

**Parameters:**
- `limit` (optional, default: 20, max: 100) - Results per page
- `cursor` (optional) - Cursor from previous response

**Response:**
```typescript
{
  address: string
  data: Attestation[]
  page: {
    nextCursor: string | null
    hasMore: boolean
    limit: number
  }
}
```

### GET /api/transactions/history

List transaction settlements with cursor-based pagination.

**Parameters:**
- `limit` (optional, default: 20, max: 100) - Results per page
- `cursor` (optional) - Cursor from previous response
- `bondId` (optional) - Filter by bond ID

**Response:**
```typescript
{
  success: boolean
  data: Settlement[]
  page: {
    nextCursor: string | null
    hasMore: boolean
    limit: number
  }
}
```
