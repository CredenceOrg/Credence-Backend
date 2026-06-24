# Import Preview API

The import preview endpoint lets you validate a CSV file of Stellar addresses before committing a bulk import. It returns a summary of valid/invalid rows and per-row error details without persisting any data.

---

## Endpoint

```
POST /api/imports/preview
```

**Auth:** `X-API-Key` header with an Enterprise-scoped key (or `Authorization: Bearer <key>`).

**Content-Type:** `multipart/form-data`

**Field:** `file` — the CSV file to validate.

---

## Limits

| Constraint | Value |
|---|---|
| Maximum file size | 512 KB |
| Maximum rows scanned | 10 000 |
| Maximum cell size | 1 024 bytes |
| Parse timeout | 5 000 ms |
| Files per request | 1 |

Files exceeding the size limit are rejected by multer before any bytes are parsed. Rows beyond the row limit are still consumed to report an accurate `totalDataRowsInFile`, but are not included in the scan results.

---

## Accepted file types

The endpoint accepts only CSV files. Both MIME type and file extension are checked:

| MIME type | Notes |
|---|---|
| `text/csv` | Standard CSV MIME type |
| `text/plain` | Accepted when extension is `.csv` |
| `application/csv` | Alternative CSV MIME type |
| `application/vnd.ms-excel` | Sent by some Excel CSV exports |

Any other MIME type or non-`.csv` extension returns `415 Unsupported Media Type`.

---

## CSV format

- The first row must be a header row containing an `address` column (case-insensitive).
- Additional columns are allowed and ignored.
- The file must be valid UTF-8 (BOM is stripped automatically).
- Empty lines are skipped.

**Minimal example:**

```csv
address
GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN
GBCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
```

**With extra columns:**

```csv
name,address,notes
Alice,GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN,primary
Bob,GBCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC,secondary
```

---

## Request example

```bash
curl -X POST https://api.credence.org/api/imports/preview \
  -H "X-API-Key: your-enterprise-key" \
  -F "file=@addresses.csv"
```

---

## Response — success (200)

```json
{
  "summary": {
    "totalRowsScanned": 3,
    "validRows": 2,
    "invalidRows": 1,
    "truncated": false,
    "truncatedReason": null
  },
  "preview": {
    "validSample": [
      { "line": 2, "data": { "address": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN" } }
    ],
    "invalidSample": [
      {
        "line": 3,
        "data": { "address": "not-a-stellar-address" },
        "errors": ["Invalid Stellar address"]
      }
    ]
  },
  "rowErrors": [
    {
      "line": 3,
      "column": "address",
      "code": "INVALID_ADDRESS",
      "message": "Invalid Stellar address"
    }
  ]
}
```

When the file contains more rows than the limit, `truncated` is `true` and `totalDataRowsInFile` is included:

```json
{
  "summary": {
    "totalRowsScanned": 10000,
    "validRows": 9800,
    "invalidRows": 200,
    "truncated": true,
    "truncatedReason": "row_limit",
    "totalDataRowsInFile": 15000
  },
  ...
}
```

---

## Error responses

| Status | `code` | Cause |
|---|---|---|
| `400` | `MissingFile` | No `file` field in the multipart body |
| `400` | `SchemaError` | CSV header does not contain an `address` column |
| `400` | `MalformedCsv` | File cannot be parsed as CSV |
| `400` | `InvalidEncoding` | File is not valid UTF-8 |
| `400` | `CellTooLarge` | A cell value exceeds 1 024 bytes |
| `400` | `TooManyFiles` | More than one file attached |
| `401` | `Unauthorized` | Missing or invalid API key |
| `403` | `Forbidden` | API key lacks Enterprise scope |
| `408` | `ParseTimeout` | Parsing exceeded the 5 000 ms timeout |
| `413` | `FileTooLarge` | File exceeds 512 KB |
| `415` | `InvalidFileType` | File is not a CSV (wrong MIME type or extension) |

All error responses follow this shape:

```json
{
  "error": "InvalidRequest",
  "code": "SchemaError",
  "message": "CSV header must include an \"address\" column.",
  "line": 1
}
```

`line` is only present for errors that can be attributed to a specific row.

---

## Security

### Formula injection

Cell values in the `preview` output that begin with `=`, `+`, `-`, or `@` are prefixed with a tab character (`\t`). This prevents spreadsheet applications from interpreting them as formulas if the response is exported to a file.

### File-type enforcement

Both the MIME type reported by the client and the file extension are checked. A file named `malware.exe` with `Content-Type: text/csv` is rejected because the extension is not `.csv`. A file named `data.csv` with `Content-Type: application/json` is also rejected.

### Memory safety

multer is configured with `memoryStorage()` and a hard `fileSize` limit. Files over 512 KB are rejected before any bytes reach the parser, preventing memory exhaustion from large uploads.

---

## Row error codes

| Code | Column | Meaning |
|---|---|---|
| `MISSING_ADDRESS` | `address` | The address cell is empty |
| `INVALID_ADDRESS` | `address` | The value is not a valid Stellar public key or federation address |

---

# Import Mapping Presets

Mapping presets allow you to define reusable column-mapping configurations per organization. Each preset maps CSV column headers to canonical column names, so imports from different sources (with different headers) can be processed deterministically.

Presets are versioned — when you update a preset, the version number is automatically incremented. This creates an auditable history of mapping changes.

## Endpoints

All preset endpoints require an Enterprise-scoped API key (`X-API-Key` header).

### `GET /api/imports/presets`

List all mapping presets for the current organization.

```bash
curl -X GET https://api.credence.org/api/imports/presets \
  -H "X-API-Key: your-enterprise-key"
```

**Response (200):**
```json
{
  "presets": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "orgId": "default-tenant",
      "name": "Standard",
      "version": 1,
      "columnMappings": {
        "Wallet Address": "address",
        "Email": "email"
      },
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/imports/presets`

Create a new mapping preset. If a preset with the same `name` already exists for the organization, the `version` is automatically incremented.

```bash
curl -X POST https://api.credence.org/api/imports/presets \
  -H "X-API-Key: your-enterprise-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Exchange Export",
    "columnMappings": {
      "Wallet": "address",
      "Email Address": "email",
      "Full Name": "name"
    }
  }'
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Human-readable preset name |
| `columnMappings` | object | yes | Maps CSV header names (keys) to canonical column names (values) |

**Response (201):**
```json
{
  "preset": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "orgId": "default-tenant",
    "name": "Exchange Export",
    "version": 1,
    "columnMappings": {
      "Wallet": "address",
      "Email Address": "email",
      "Full Name": "name"
    },
    "createdAt": "2025-01-15T10:00:00.000Z",
    "updatedAt": "2025-01-15T10:00:00.000Z"
  }
}
```

**Error (400):** Missing or invalid `name` or `columnMappings`.

---

### `GET /api/imports/presets/:id`

Retrieve a single mapping preset by ID.

```bash
curl -X GET https://api.credence.org/api/imports/presets/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: your-enterprise-key"
```

**Response (200):** Single preset object.
**Response (404):** `PresetNotFound` — preset does not exist.

---

### `PUT /api/imports/presets/:id`

Update an existing mapping preset. The `version` is automatically incremented on each update.

```bash
curl -X PUT https://api.credence.org/api/imports/presets/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: your-enterprise-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Exchange Export v2",
    "columnMappings": {
      "Wallet": "address",
      "Email Address": "email"
    }
  }'
```

**Request body:** Both fields are optional (partial update).

| Field | Type | Description |
|---|---|---|
| `name` | string | New name for the preset |
| `columnMappings` | object | New column mappings |

**Response (200):** Updated preset with incremented version.
**Response (404):** `PresetNotFound`.

---

### `DELETE /api/imports/presets/:id`

Delete a mapping preset.

```bash
curl -X DELETE https://api.credence.org/api/imports/presets/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: your-enterprise-key"
```

**Response (204):** No content — successful deletion.
**Response (404):** `PresetNotFound`.

---

### `POST /api/imports/preview/:presetId`

Preview an import file using a column-mapping preset. Behaves identically to `POST /api/imports/preview` but also returns the applied preset metadata.

```bash
curl -X POST https://api.credence.org/api/imports/preview/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: your-enterprise-key" \
  -F "file=@addresses.csv"
```

**Response (200):** Same shape as `POST /api/imports/preview` with an additional `preset` field:

```json
{
  "summary": { ... },
  "preview": { ... },
  "rowErrors": [ ... ],
  "preset": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Exchange Export",
    "version": 1,
    "columnMappings": {
      "Wallet": "address",
      "Email Address": "email",
      "Full Name": "name"
    }
  }
}
```

**Response (404):** `PresetNotFound` — preset does not exist.

---

## Column mapping format

The `columnMappings` object maps CSV header names (keys) to canonical column names (values):

```json
{
  "CSV Header Name": "canonical_column",
  "Another Header": "another_column"
}
```

**Matching rules:**
- Header matching is **case-insensitive** (`"Wallet"` matches `"wallet"`, `"WALLET"`, etc.)
- UTF-8 BOM characters in the first header are automatically stripped
- Only columns present in both the CSV and the mapping are included in the result
- If multiple mappings target the same canonical column, the last matching CSV header wins
- Missing CSV columns in a row produce an empty string
- Cell values are trimmed and sanitized (formula injection prefixes `=`, `+`, `-`, `@` are prefixed with a tab)

---

## Versioning

Each preset belongs to an `(org_id, name)` group. When you create a new preset with the same name as an existing one, the version is auto-incremented:

- `Exchange Export` → version 1
- `Exchange Export` → version 2 (after update or re-creation)
- `Exchange Export` → version 3

Versions are independent across different preset names and different organizations.

---

## Error codes

| Status | `code` | Cause |
|---|---|---|
| `400` | `ValidationError` | Invalid or missing `name` / `columnMappings` in request body |
| `400` | `MissingTenant` | Tenant context could not be determined |
| `404` | `PresetNotFound` | Preset ID does not exist |
