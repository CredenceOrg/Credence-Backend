# CSV Import Dry-Run API

The dry-run endpoints validate a CSV import file against the active column-mapping schema and return a per-row error report **without persisting any data**. Use them to catch bad rows before committing a bulk import.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/imports/dry-run` | Validate using the default mapping (`address` CSV column → `address` canonical column) |
| `POST` | `/api/imports/dry-run/:presetId` | Validate using an org mapping preset |
| `POST` | `/api/imports/commit?dryRun=true` | Validate without persisting (same response as dry-run) |
| `POST` | `/api/imports/commit` | Commit a validated import (persists on success) |
| `POST` | `/api/imports/commit/:presetId?dryRun=true` | Dry-run with preset via commit endpoint |
| `POST` | `/api/imports/commit/:presetId` | Commit with preset column mapping |

**Auth:** `X-API-Key` header with an Enterprise-scoped key.

**Content-Type:** `multipart/form-data`

**Field:** `file` — the CSV file to validate.

---

## Limits

Same upload and parse limits as the preview endpoint (see [imports.md](./imports.md)):

| Constraint | Value |
|---|---|
| Maximum file size | 512 KB |
| Maximum rows scanned | 10 000 |
| Maximum cell size | 1 024 bytes |
| Parse timeout | 5 000 ms |
| Maximum reported row errors | 100 |
| Files per request | 1 |

Parsing is **streaming** via csv-parse; the full file is not materialised beyond the multer upload buffer.

---

## Request examples

**Default mapping:**

```bash
curl -X POST https://api.credence.org/api/imports/dry-run \
  -H "X-API-Key: your-enterprise-key" \
  -F "file=@addresses.csv"
```

**With a mapping preset:**

```bash
curl -X POST https://api.credence.org/api/imports/dry-run/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: your-enterprise-key" \
  -F "file=@exchange-export.csv"
```

**Dry-run via commit endpoint (`?dryRun=true`):**

```bash
curl -X POST "https://api.credence.org/api/imports/commit?dryRun=true" \
  -H "X-API-Key: your-enterprise-key" \
  -F "file=@addresses.csv"
```

**Commit after validation passes:**

```bash
curl -X POST https://api.credence.org/api/imports/commit \
  -H "X-API-Key: your-enterprise-key" \
  -F "file=@addresses.csv"
```

---

## Response — success (200)

```json
{
  "valid": false,
  "totalRows": 3,
  "errors": [
    {
      "row": 3,
      "column": "address",
      "code": "INVALID_ADDRESS",
      "message": "Invalid Stellar address"
    }
  ],
  "errorsTruncated": false
}
```

| Field | Type | Description |
|---|---|---|
| `valid` | boolean | `true` only when every scanned row passes validation **and** the full file was scanned (not truncated by the row limit) |
| `totalRows` | number | Data rows validated (up to the row scan limit) |
| `errors` | array | Per-row validation errors (capped at 100) |
| `errorsTruncated` | boolean | `true` when additional errors were omitted due to the cap or row limit |

When using a preset, the response also includes:

```json
{
  "preset": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Exchange Export",
    "version": 1,
    "columnMappings": {
      "Wallet": "address",
      "Email Address": "email"
    }
  }
}
```

---

## Row error codes

| Code | Column | Meaning |
|---|---|---|
| `MISSING_ADDRESS` | `address` | The address cell is empty after column mapping |
| `INVALID_ADDRESS` | `address` | The value is not a valid Stellar public key |
| `INVALID_EMAIL` | `email` | The email value is present but malformed |
| `DUPLICATE_KEY` | `address` | The same address appears on an earlier row |

All row errors include `row` (1-based CSV line number), `column`, `code`, and `message`.

---

## File-level error responses

| Status | `code` | Cause |
|---|---|---|
| `400` | `MissingFile` | No `file` field in the multipart body |
| `400` | `SchemaError` | CSV header does not include a column mapped to `address`, or the mapping schema is invalid |
| `400` | `MalformedCsv` | File cannot be parsed as CSV |
| `400` | `InvalidEncoding` | File is not valid UTF-8 |
| `400` | `CellTooLarge` | A cell value exceeds 1 024 bytes |
| `401` | `Unauthorized` | Missing or invalid API key |
| `403` | `Forbidden` | API key lacks Enterprise scope |
| `404` | `PresetNotFound` | Preset ID does not exist (preset dry-run only) |
| `408` | `ParseTimeout` | Parsing exceeded the 5 000 ms timeout |
| `413` | `FileTooLarge` | File exceeds 512 KB |
| `415` | `InvalidFileType` | File is not a CSV |

---

## Column mapping schema

The active mapping schema is validated with Zod before parsing begins. Supported canonical columns:

| Canonical column | Required | Validation |
|---|---|---|
| `address` | yes | Must map from at least one CSV header; non-empty valid Stellar address per row |
| `email` | no | Validated when present and non-empty |
| `name` | no | Accepted as-is |

Presets must include a mapping to the `address` canonical column. Header matching is case-insensitive; see [imports.md](./imports.md#column-mapping-format) for full mapping rules.

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| Empty file | `valid: true`, `totalRows: 0`, `errors: []` |
| Header-only file | `valid: true`, `totalRows: 0`, `errors: []` |
| Mixed valid/invalid rows | `valid: false`; only invalid rows appear in `errors` |
| Duplicate addresses | Second and later occurrences receive `DUPLICATE_KEY` |
| More than 100 errors | First 100 returned; `errorsTruncated: true` |
| More than 10 000 rows | First 10 000 validated; `errorsTruncated: true` |
| Very large file (within 512 KB) | Streamed row-by-row; no full in-memory row array |

---

## Commit response — success (201)

When `?dryRun` is absent or not `true`, a valid file is persisted:

```json
{
  "committed": true,
  "totalRows": 3,
  "imported": 3
}
```

If validation fails, commit returns **422** with the same error report shape as dry-run (`ImportValidationFailed`).

---

## Dry-run vs preview

| | Dry-run | Preview |
|---|---|---|
| Persists data | Never | Never |
| Column mapping | Yes (preset or default) | Preview endpoint ignores mapping; preset preview returns metadata only |
| Response shape | `{ valid, totalRows, errors, errorsTruncated }` | `{ summary, preview, rowErrors }` |
| Sample rows | No | Yes (`validSample` / `invalidSample`) |

Use dry-run when you need a complete validation report against a mapping preset before commit. Use preview for a quick human-readable sample of the file contents.
