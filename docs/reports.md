# Reports

## Overview

The reports system generates asynchronous report artifacts, streams them to
object storage, and serves them via short-lived signed download URLs.

## Architecture

```
POST /api/reports          →  ReportService.startReportGeneration()
    (202 Accepted)              ├─ ReportRepository.create()  → INSERT queued
                                └─ ReportWorker.processReport()  (background)
                                     ├─ updateStatus(RUNNING)
                                     ├─ generateReportStream()  → AsyncIterable<Buffer>
                                     ├─ ReportStorageService.uploadStream(key, stream)
                                     └─ updateStatus(COMPLETED, { storageKey })

GET  /api/reports/:jobId   →  ReportService.getReportStatus()
    (200 OK)                   ├─ Cache hit → return cached job
                               ├─ Cache miss → ReportRepository.findById()
                               └─ If COMPLETED: mint signed download URL

GET  /api/reports/download/:key
    (200 OK)                →  ReportStorageService.verifyAndRetrieve()
                               If valid signature + not expired → serve artifact
                               Otherwise → 401
```

## Endpoints

### `POST /api/reports`

Start a report generation job.

**Auth:** Enterprise API key (`X-API-Key` header)

**Body:**
```json
{ "type": "trust_score_summary" }
```

**Response (202):**
```json
{
  "jobId": "uuid",
  "status": "queued",
  "type": "trust_score_summary",
  "createdAt": "ISO8601"
}
```

### `GET /api/reports/:jobId`

Check report generation status.

**Auth:** Enterprise API key

**Response (200):**
```json
{
  "jobId": "uuid",
  "status": "completed",
  "type": "trust_score_summary",
  "artifactUrl": "https://credence.example.com/api/reports/download/...?expires=...&signature=...",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

- `artifactUrl` is a short-lived (15 min) signed download URL (HMAC-SHA256).
- `failureReason` is present only when `status === "failed"`.

### `GET /api/reports/download/:key`

Download a report artifact. No API key required — the URL is self-authenticating.

**Query params:**
- `expires` — Expiration timestamp (epoch ms)
- `signature` — HMAC-SHA256 signature of `{key}:{expires}`

**Response (200):** PDF file download

**Error (401):** Invalid or expired signed URL

## Storage

Artifacts are keyed as `reports/{tenantId}/{jobId}.pdf` to isolate tenants.

The `ReportStorageService` uses an in-memory map for development. In production,
replace with S3/GCS/CloudFiles using the same interface:

```typescript
interface IReportStorageService {
  makeKey(tenantId: string, jobId: string): string
  uploadStream(key: string, readable: AsyncIterable<Buffer>): Promise<void>
  generateSignedUrl(key: string): SignedUrl
  verifyAndRetrieve(key: string, expires: number, signature: string): Buffer | null
  exists(key: string): boolean
  retrieve(key: string): Buffer | null
  delete(key: string): Promise<boolean>
}
```

## Streaming

Report generation uses `AsyncIterable<Buffer>` to avoid buffering large reports
in memory. The `ReportWorker.generateReportStream()` method yields chunks
on-demand, mirroring the `ExportWorker` streaming pattern.

## Security

- **Signed URLs:** HMAC-SHA256 with constant-time comparison (`crypto.timingSafeEqual`)
- **Short-lived:** URLs expire after 15 minutes by default (configurable: `REPORT_DOWNLOAD_TTL_MS`)
- **No public listing:** Artifacts are key-addressable only; no bucket enumeration
- **Tenant isolation:** Storage keys include `tenantId`
- **Download endpoint:** Self-authenticating — no API key required for signed URLs

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REPORT_STORAGE_SIGNING_SECRET` | Yes | — | HMAC secret for signing download URLs |
| `REPORT_DOWNLOAD_BASE_URL` | No | `https://credence.example.com` | Base URL for signed download links |

## Testing

```bash
# Unit tests
npx vitest run src/services/reportStorage.test.ts src/services/reportService.test.ts

# Integration tests (worker → storage → signed URL)
npx vitest run src/jobs/reportWorker.test.ts
```
