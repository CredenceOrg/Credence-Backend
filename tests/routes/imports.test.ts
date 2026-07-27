/**
 * Integration tests for `POST /api/imports/preview` and the surrounding
 * import domain — placed at the conventional `tests/routes/` path so it
 * runs as part of the broader integration suite.
 *
 * These tests sit alongside the unit-level tests in
 * `src/routes/imports.test.ts`. They focus on:
 *
 *  1. **Response-contract enforcement** — every 2xx/4xx body must parse
 *     against the corresponding zod schema in `src/schemas/imports.ts`.
 *     This locks the wire contract so SDK/OpenAPI generators can trust it.
 *  2. **Streaming safety** — a large CSV must complete well under the
 *     service's `IMPORT_PREVIEW_MAX_PARSE_MS` budget, the server must not
 *     block, and a small request immediately afterwards must still respond
 *     quickly (proving the event loop stayed unblocked).
 *  3. **Security sanitization** — formula-injection cells start with `=`,
 *     `+`, `-`, `@`, `\t`, `\r` and MUST be prefixed with a tab in the
 *     `preview.validSample[*].data.address` field, never echoed raw.
 *  4. **Error envelope coverage** — missing file, oversized file, missing
 *     `address` header, malformed CSV, and invalid UTF-8 each produce the
 *     matching `code` from `ImportPreviewErrorResponse.code`.
 *
 * Auth: relies on the hardcoded test key `test-enterprise-key-12345` in
 * `src/middleware/auth.ts`, which is mapped to `ApiScope.ENTERPRISE` for
 * tests. No auth middleware is required at the test app boundary.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import importsRouter from '../../src/routes/imports.js'
import {
  importPreviewSuccessResponseSchema,
  importPreviewErrorResponseSchema,
  type ImportPreviewSuccessResponse,
  type ImportPreviewErrorResponse,
} from '../../src/schemas/imports.js'
import {
  IMPORT_PREVIEW_MAX_FILE_BYTES,
  IMPORT_PREVIEW_MAX_ROWS,
  IMPORT_PREVIEW_MAX_CELL_BYTES,
} from '../../src/services/importPreviewService.js'

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture
// ─────────────────────────────────────────────────────────────────────────────

function createApp(): express.Express {
  const app = express()
  app.use('/api/imports', importsRouter)
  // Belt-and-braces error handler — never let Express' default HTML 500 leak.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: 'InternalServerError', message: String(err) })
    },
  )
  return app
}

const ENTERPRISE_KEY = 'test-enterprise-key-12345'

/** A valid Stellar public key matching `^G[A-Z2-7]{55}$`. */
const VALID_ADDRESS = 'G' + 'A'.repeat(55)

/** Build an `address`-headered CSV. Each row is `data` followed by newline. */
function csvBuffer(rows: string[]): Buffer {
  return Buffer.from(['address', ...rows].join('\n'), 'utf8')
}

interface PostOptions {
  apiKey?: string
  fileBuffer?: Buffer
  filename?: string
  mimeType?: string
  fieldName?: string
}

function postPreview(
  app: express.Express,
  {
    apiKey = ENTERPRISE_KEY,
    fileBuffer = csvBuffer([VALID_ADDRESS]),
    filename = 'import.csv',
    mimeType = 'text/csv',
    fieldName = 'file',
  }: PostOptions = {},
) {
  let req = request(app).post('/api/imports/preview').set('X-API-Key', apiKey)
  if (fileBuffer !== undefined) {
    req = req.attach(fieldName, fileBuffer, { filename, contentType: mimeType })
  }
  return req
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Response contract — success path
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/imports/preview — response contract', () => {
  let app: express.Express
  beforeEach(() => {
    app = createApp()
  })

  it('returns a body that conforms to importPreviewSuccessResponseSchema', async () => {
    const res = await postPreview(app, { fileBuffer: csvBuffer([VALID_ADDRESS]) })

    expect(res.status).toBe(200)
    // Throws on mismatch; rejects if the service ever drifts from the contract.
    const parsed: ImportPreviewSuccessResponse = importPreviewSuccessResponseSchema.parse(
      res.body,
    )
    expect(parsed.summary.totalRowsScanned).toBe(1)
    expect(parsed.summary.validRows).toBe(1)
    expect(parsed.preview.validSample[0]?.data.address).toBe(VALID_ADDRESS)
    expect(parsed.rowErrors).toHaveLength(0)
  })

  it('reports invalid addresses in rowErrors, not in validSample', async () => {
    const res = await postPreview(app, {
      fileBuffer: csvBuffer(['not-a-stellar-address', VALID_ADDRESS]),
    })

    expect(res.status).toBe(200)
    const parsed = importPreviewSuccessResponseSchema.parse(res.body)
    expect(parsed.summary.validRows).toBe(1)
    expect(parsed.summary.invalidRows).toBe(1)
    expect(parsed.preview.validSample).toHaveLength(1)
    expect(parsed.preview.invalidSample).toHaveLength(1)
    expect(parsed.preview.invalidSample[0]?.data.address).toBe('not-a-stellar-address')
    expect(parsed.preview.invalidSample[0]?.errors[0]).toMatch(/invalid stellar/i)
    expect(parsed.rowErrors).toHaveLength(1)
    expect(parsed.rowErrors[0]?.code).toBe('INVALID_ADDRESS')
  })

  it('returns an empty success body for a header-only CSV', async () => {
    const res = await postPreview(app, {
      fileBuffer: Buffer.from('address\n', 'utf8'),
    })

    expect(res.status).toBe(200)
    const parsed = importPreviewSuccessResponseSchema.parse(res.body)
    expect(parsed.summary.totalRowsScanned).toBe(0)
    expect(parsed.preview.validSample).toHaveLength(0)
    expect(parsed.preview.invalidSample).toHaveLength(0)
    expect(parsed.rowErrors).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Response contract — error envelopes
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/imports/preview — error envelopes', () => {
  let app: express.Express
  beforeEach(() => {
    app = createApp()
  })

  it('returns 400 MissingFile when no file is attached (envelope conforms to schema)', async () => {
    const res = await request(app)
      .post('/api/imports/preview')
      .set('X-API-Key', ENTERPRISE_KEY)
      .field('dummy', 'value')

    expect(res.status).toBe(400)
    const parsed: ImportPreviewErrorResponse = importPreviewErrorResponseSchema.parse(
      res.body,
    )
    expect(parsed.code).toBe('MissingFile')
  })

  it('returns 400 SchemaError when the headline column "address" is missing', async () => {
    const res = await postPreview(app, {
      fileBuffer: Buffer.from('email,amount\nfoo@bar.com,1\n', 'utf8'),
    })

    expect(res.status).toBe(400)
    const parsed = importPreviewErrorResponseSchema.parse(res.body)
    expect(parsed.code).toBe('SchemaError')
    expect(parsed.line).toBe(1)
  })

  it('returns 400 CellTooLarge when a single cell exceeds IMPORT_PREVIEW_MAX_CELL_BYTES', async () => {
    const oversizedCell = 'A'.repeat(IMPORT_PREVIEW_MAX_CELL_BYTES + 1)
    const res = await postPreview(app, {
      fileBuffer: csvBuffer([oversizedCell]),
    })

    expect(res.status).toBe(400)
    const parsed = importPreviewErrorResponseSchema.parse(res.body)
    expect(parsed.code).toBe('CellTooLarge')
    expect(parsed.line).toBe(2)
  })

  it('returns 413 FileTooLarge when the upload exceeds IMPORT_PREVIEW_MAX_FILE_BYTES', async () => {
    // 1 byte past the cap — multer's fileSize limit rejects BEFORE the
    // service runs (this is the streaming-safety boundary).
    const oversized = Buffer.alloc(IMPORT_PREVIEW_MAX_FILE_BYTES + 1, 'a')
    const res = await postPreview(app, { fileBuffer: oversized })

    expect(res.status).toBe(413)
    const parsed = importPreviewErrorResponseSchema.parse(res.body)
    expect(parsed.code).toBe('FileTooLarge')
  })

  it('returns 400 InvalidEncoding for non-UTF-8 bytes', async () => {
    // Latin-1 byte 0xFF is invalid UTF-8 at the very start.
    const res = await postPreview(app, {
      fileBuffer: Buffer.concat([Buffer.from([0xff]), csvBuffer([VALID_ADDRESS])]),
    })

    expect(res.status).toBe(400)
    const parsed = importPreviewErrorResponseSchema.parse(res.body)
    expect(parsed.code).toBe('InvalidEncoding')
  })

  it('returns 415 InvalidFileType for non-CSV MIME types', async () => {
    const res = await postPreview(app, {
      mimeType: 'application/json',
      filename: 'data.json',
    })

    expect(res.status).toBe(415)
    const parsed = importPreviewErrorResponseSchema.parse(res.body)
    expect(parsed.code).toBe('InvalidFileType')
  })

  it('returns 401 when no API key is supplied', async () => {
    const res = await request(app)
      .post('/api/imports/preview')
      .attach('file', csvBuffer([VALID_ADDRESS]))

    expect(res.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Streaming safety
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/imports/preview — streaming safety', () => {
  let app: express.Express
  beforeEach(() => {
    app = createApp()
  })

  it('returns counts correctly for a 3000-row mix of valid and invalid addresses', async () => {
    // 3000 rows is well under the 10K scan cap, so every row is counted.
    const rows: string[] = []
    for (let i = 0; i < 1500; i++) rows.push(VALID_ADDRESS) // valid
    for (let i = 0; i < 1500; i++) rows.push(`bogus-${i}`) // will fail validation

    const start = Date.now()
    const res = await postPreview(app, { fileBuffer: csvBuffer(rows) })
    const elapsedMs = Date.now() - start

    expect(res.status).toBe(200)
    const parsed = importPreviewSuccessResponseSchema.parse(res.body)
    expect(parsed.summary.totalRowsScanned).toBe(3000)
    expect(parsed.summary.validRows).toBe(1500)
    expect(parsed.summary.invalidRows).toBe(1500)
    expect(parsed.summary.truncated).toBe(false)
    // Generous bound — streaming should keep this well under the 5s parse cap.
    expect(elapsedMs).toBeLessThan(2000)
  })

  it('keeps the event loop responsive: a small follow-up request completes well under the parse budget', async () => {
    const rows: string[] = []
    for (let i = 0; i < 2000; i++) rows.push(VALID_ADDRESS)

    // 1) larger request
    const big = await postPreview(app, { fileBuffer: csvBuffer(rows) })
    expect(big.status).toBe(200)

    // 2) tiny request immediately after — proves the event loop wasn't blocked.
    // 500ms is intentionally generous to absorb CI noise (supertest +
    // auth middleware + JSON parsing + zod parse); the point is that the
    // event loop didn't stall, not that the roundtrip is fast in absolute
    // terms.
    const start = Date.now()
    const small = await postPreview(app, {
      fileBuffer: csvBuffer([VALID_ADDRESS]),
    })
    const elapsedMs = Date.now() - start

    expect(small.status).toBe(200)
    expect(elapsedMs).toBeLessThan(500)
  })

  // NOTE: row-count truncation (≥ 10 K rows in the source CSV) cannot be
  // exercised through this route: `IMPORT_PREVIEW_MAX_FILE_BYTES` (512 KiB)
  // is enforced by multer BEFORE the service runs, and 10 K rows of full
  // Stellar addresses (~57 B each) already exceed that byte cap. Truncation
  // is therefore covered directly against `previewImportFile` in
  // `src/routes/imports.test.ts` (the unit-level suite), where the service
  // boundary can be invoked with a buffer that bypasses upload middleware.

  it('caps upload size BEFORE the service runs (multer LIMIT_FILE_SIZE → 413)', async () => {
    // multer enforces the file-size limit during streaming upload, not after
    // the buffer is fully loaded — this is the streaming-safety net on the
    // upload side. The service's IMPORT_PREVIEW_MAX_FILE_BYTES check is a
    // belt-and-braces second guard.
    const oversized = Buffer.alloc(IMPORT_PREVIEW_MAX_FILE_BYTES + 1, 'a')
    const res = await postPreview(app, { fileBuffer: oversized })

    expect(res.status).toBe(413)
    const parsed = importPreviewErrorResponseSchema.parse(res.body)
    expect(parsed.code).toBe('FileTooLarge')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Formula-injection sanitization
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/imports/preview — formula-injection sanitization', () => {
  let app: express.Express
  beforeEach(() => {
    app = createApp()
  })

  it('prefixes spreadsheet-formula cells with a tab so they render as text', async () => {
    // These will be flagged as INVALID_ADDRESS (not Stellar addresses), but
    // importantly the cell payload is sanitized in both invalidSample and
    // any other echoed-back field, never echoed raw.
    const injectionCells = ['=cmd|"/c calc"!A1', '+SUM(A1:A10)', '-2+3', '@import', '\tinjected']
    const res = await postPreview(app, {
      fileBuffer: csvBuffer(injectionCells),
    })

    expect(res.status).toBe(200)
    const parsed = importPreviewSuccessResponseSchema.parse(res.body)
    expect(parsed.summary.invalidRows).toBe(5)

    // Every echoed cell must be prefixed with `\t` so a spreadsheet can't
    // interpret the value as an executable formula.
    const echoedAddresses = parsed.preview.invalidSample.map((e) => e.data.address)
    for (const echoed of echoedAddresses) {
      expect(echoed.startsWith('\t')).toBe(true)
    }
    // Sanity: the original payload characters must still be present after
    // the tab prefix.
    expect(echoedAddresses[0]).toBe('\t=cmd|"/c calc"!A1')
  })

  it('does NOT prefix plain addresses (no false-positive sanitization)', async () => {
    const res = await postPreview(app, {
      fileBuffer: csvBuffer([VALID_ADDRESS]),
    })

    expect(res.status).toBe(200)
    const parsed = importPreviewSuccessResponseSchema.parse(res.body)
    expect(parsed.preview.validSample[0]?.data.address).toBe(VALID_ADDRESS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Zod schema rejection
// ─────────────────────────────────────────────────────────────────────────────
//
// Confirms the contract schemas REJECT shapes the service never emits —
// protects against silent contract drift and locks the wire shape.
describe('import-preview zod schemas — rejection of malformed bodies', () => {
  it('rejects a body that includes the inner service wrapper field "success"', () => {
    // The route strips `success: true` before sending; a body that still
    // carries it means the service changed shape. `.strict()` makes that
    // throw at parse time.
    const malformed = {
      success: true,
      summary: {
        totalRowsScanned: 1,
        validRows: 1,
        invalidRows: 0,
        truncated: false,
        truncatedReason: null,
      },
      preview: { validSample: [], invalidSample: [] },
      rowErrors: [],
    }
    expect(() => importPreviewSuccessResponseSchema.parse(malformed)).toThrow()
  })

  it('rejects a summary with an out-of-range truncatedReason', () => {
    const bad = {
      summary: {
        totalRowsScanned: 1,
        validRows: 1,
        invalidRows: 0,
        truncated: false,
        truncatedReason: 'something_else', // not in the literal union
      },
      preview: { validSample: [], invalidSample: [] },
      rowErrors: [],
    }
    expect(() => importPreviewSuccessResponseSchema.parse(bad)).toThrow()
  })

  it('rejects an error envelope whose code is not in the canonical enum', () => {
    const bad = {
      error: 'InvalidRequest',
      code: 'NotARealCode',
      message: 'oops',
    }
    expect(() => importPreviewErrorResponseSchema.parse(bad)).toThrow()
  })
})
