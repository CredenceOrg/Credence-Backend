# Pagination Contract

Audience: downstream API integrators building clients that consume list endpoints.

This document is the authoritative reference for how every paginated endpoint in the Credence Backend behaves. Implementations live in [`src/lib/pagination.ts`](../src/lib/pagination.ts).

---

## Two pagination modes

The API exposes two pagination modes. Endpoints advertise which mode they use in their individual docs.

| Mode | Query params | Use when |
|------|-------------|----------|
| **Offset / page** | `page`, `limit` | Simple UIs with numbered pages, small datasets |
| **Cursor** | `cursor`, `limit` | Stable iteration over large / frequently-updated datasets |

Both modes share a common `limit` parameter and return identical validation errors.

---

## Offset / page pagination

### Request parameters

| Parameter | Type    | Default | Constraints           | Description                             |
|-----------|---------|---------|-----------------------|-----------------------------------------|
| `page`    | integer | `1`     | ≥ 1                   | 1-indexed page number                   |
| `limit`   | integer | `20`    | 1 – 100               | Records per page                        |
| `offset`  | integer | —       | ≥ 0                   | Row offset (alternative to `page`; see below) |

`offset` and `page` address the same axis. If you supply `offset` without `page`, the server derives `page` as `⌊offset / limit⌋ + 1`. If you supply both, `offset` takes precedence.

Some admin endpoints override the default `limit` to `50`; the max (`100`) is always the same.

### Response envelope

```json
{
  "data": [ ...items... ],
  "page":    2,
  "limit":   20,
  "total":   87,
  "hasNext": true
}
```

| Field     | Type    | Description                                                  |
|-----------|---------|--------------------------------------------------------------|
| `page`    | integer | Page that was returned                                       |
| `limit`   | integer | Page size that was applied                                   |
| `total`   | integer | Total matching records (used to compute last page)           |
| `hasNext` | boolean | `true` when `page * limit < total`                          |

### Example

Fetch the second page of attestations for an identity, 10 per page:

```bash
curl "http://localhost:3000/api/attestations/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266?page=2&limit=10"
```

```json
{
  "identity": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "attestations": [ ... ],
  "page":    2,
  "limit":   10,
  "total":   34,
  "hasNext": true
}
```

Iterate until `hasNext` is `false` (or `page * limit >= total`).

---

## Cursor-based pagination

Used by endpoints where consistent ordering under concurrent writes matters — for example `GET /api/transactions/history`.

### How the cursor works

Each page response includes a `next_cursor` value. Pass it as `cursor` on the next request. The cursor is an opaque base64url-encoded token that encodes two fields internally:

```
cursor = base64url( JSON.stringify({ t: "<ISO-8601 timestamp>", i: "<record UUID>" }) )
```

| Internal field | Meaning                                        |
|---------------|------------------------------------------------|
| `t`           | `settledAt` (or equivalent) ISO 8601 timestamp |
| `i`           | Record UUID (tie-breaker within the same timestamp) |

**Do not construct or parse cursors.** Treat them as opaque strings. The internal encoding may change; the only stable contract is the request/response shape documented here.

### Request parameters

| Parameter | Type   | Default | Constraints | Description                                    |
|-----------|--------|---------|-------------|------------------------------------------------|
| `cursor`  | string | —       | Opaque      | Token returned by the previous page's response |
| `limit`   | integer | `20`   | 1 – 100     | Records per page                               |

Omit `cursor` (or leave it empty) to start from the beginning of the result set.

### Response envelope

```json
{
  "success":     true,
  "data":        [ ...items... ],
  "next_cursor": "eyJ0IjoiMjAyNC0wMS0xNVQwMDowMDowMC4wMDBaIiwi..."
}
```

| Field         | Type           | Description                                             |
|---------------|----------------|---------------------------------------------------------|
| `success`     | boolean        | Always `true` on a `200` response                       |
| `data`        | array          | Up to `limit` records for this page                     |
| `next_cursor` | string \| null | Cursor for the next page; `null` when there are no more records |

When `next_cursor` is `null` you have reached the last page.

### Example: iterating transaction history

```bash
# First page
curl "http://localhost:3000/api/transactions/history?limit=5"
```

```json
{
  "success": true,
  "data": [ ... ],
  "next_cursor": "eyJ0IjoiMjAyNC0wMS0xNVQwMDowMDowMC4wMDBaIiwiaSI6IjEyMzQifQ"
}
```

```bash
# Second page — pass the cursor from the previous response
curl "http://localhost:3000/api/transactions/history?limit=5&cursor=eyJ0IjoiMjAyNC0wMS0xNVQwMDowMDowMC4wMDBaIiwiaS..."
```

Continue until `next_cursor` is `null`.

### Filtering alongside a cursor

Some cursor endpoints accept additional filters (e.g. `bondId`). Filters must remain identical across all pages of a single iteration. Changing a filter mid-iteration produces undefined results.

```bash
curl "http://localhost:3000/api/transactions/history?bondId=abc123&limit=10"
# → { "next_cursor": "..." }

curl "http://localhost:3000/api/transactions/history?bondId=abc123&limit=10&cursor=..."
```

---

## Page-size limits

| Scenario                 | Default `limit` | Max `limit` |
|--------------------------|-----------------|-------------|
| Standard list endpoints  | 20              | 100         |
| Admin user / audit-log endpoints | 50      | 100         |

Requesting a `limit` above `100` returns **400 Validation Failed**:

```json
{
  "error": "Validation failed",
  "details": [{ "path": "limit", "message": "Limit must be at most 100" }]
}
```

---

## Ordering guarantees

| Endpoint                          | Order column(s)          | Direction |
|-----------------------------------|--------------------------|-----------|
| `GET /api/attestations/:identity` | `created_at`             | ASC       |
| `GET /api/transactions/history`   | `settled_at`, then `id`  | DESC      |
| `GET /api/governance/slash-requests` | insertion order (in-memory) | ASC  |
| `GET /api/admin/users`            | implementation-defined   | —         |
| `GET /api/admin/audit-logs`       | implementation-defined   | —         |
| `GET /api/admin/members` (org)    | `created_at`             | ASC       |
| `GET /api/policies`               | implementation-defined   | —         |

The transaction history endpoint is the only one that uses cursor-based ordering. Cursor stability is guaranteed as long as rows are not back-dated — i.e. new rows always have a `settled_at` ≥ the last seen cursor timestamp.

---

## Validation errors

All parameter validation errors return **400** with the same envelope used throughout the API:

```json
{
  "error": "Validation failed",
  "details": [
    { "path": "page",  "message": "Page must be at least 1" },
    { "path": "limit", "message": "Limit must be at most 100" }
  ]
}
```

Multiple errors may appear in a single response. See [docs/VALIDATION.md](VALIDATION.md) for the full validation contract.

---

## Quick reference

```
# First page (defaults: page=1, limit=20)
GET /api/attestations/:identity

# Explicit page + limit
GET /api/attestations/:identity?page=3&limit=50

# Offset instead of page
GET /api/attestations/:identity?offset=40&limit=20

# Cursor-based (transactions)
GET /api/transactions/history?limit=25
GET /api/transactions/history?limit=25&cursor=<next_cursor from previous response>
```
