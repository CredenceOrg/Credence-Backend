# Authenticated Data Export

Cap export payloads and reject oversized requests **before** expensive
streaming work starts.

## Endpoint

```http
GET /api/export/audit-logs?from=<ISO>&to=<ISO>
```

| Item | Detail |
| --- | --- |
| Auth | `X-API-Key` with `exports:read` (or `enterprise`) |
| Tenant | Taken from `X-Tenant-Id` (via tenant context); deny-by-default scoped |
| Response | `application/x-ndjson` stream (optional `gzip` via `Accept-Encoding`) |
| Rate limit | 10 requests / minute |

### Query parameters

| Param | Default | Notes |
| --- | --- | --- |
| `from` | 30 days ago | Inclusive ISO-8601 timestamp |
| `to` | now | Inclusive ISO-8601 timestamp |

The date window cannot exceed `AUDIT_EXPORT_MAX_WINDOW_DAYS` (default **90**).

## Size limit enforcement

Before any NDJSON writer is opened or rows are streamed, `ExportService`
counts matching rows with an early-exit probe capped at `EXPORT_MAX_ROWS + 1`.

| Outcome | HTTP | Error code |
| --- | --- | --- |
| Row count ≤ `EXPORT_MAX_ROWS` | 200 + NDJSON stream | — |
| Row count > `EXPORT_MAX_ROWS` | **413** | `request_too_large` |
| Missing / wrong scope | 401 / 403 | — |
| Window too large / bad dates | 400 | `validation_failed` |

Successful responses also include:

```http
X-Export-Max-Rows: 100000
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `EXPORT_MAX_ROWS` | `100000` | Hard row cap per export (1–10 000 000) |
| `AUDIT_EXPORT_MAX_WINDOW_DAYS` | `90` | Max `from`→`to` span |

## Security notes

- Unauthenticated callers cannot hit the export route (`exports:read` required).
- Oversized exports fail closed with **413** and never open the response body stream.
- Tenant scoping is required; the route never enables `allowSuperScope`.

## Related code

- Route: `src/routes/export/`
- Service: `src/services/exportService.ts`
- Tests: `tests/routes/export.test.ts`, `src/services/exportService.test.ts`
