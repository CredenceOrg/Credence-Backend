/**
 * Integration tests for POST /api/evidence/upload
 *
 * Covers the acceptance criteria from issue #645:
 *  - Oversized file          → 413 (PayloadTooLarge / FileTooLarge)
 *  - Disallowed content-type → 415 (UnsupportedMediaType / InvalidMimeType)
 *  - Disallowed extension    → 415 (UnsupportedMediaType / InvalidFileType)
 *  - Missing file            → 400 (BadRequest / NoFiles)
 *  - Spoofed magic number    → 400 (BadRequest / ContentMismatch)
 *  - Valid upload            → 201 with storage record
 *  - Rejection before storage write (storage mock not called on bad input)
 *  - Metrics incremented for each rejection reason
 *  - Edge cases: zero-byte file, file exactly at limit, too-many-files, extra fields
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import evidenceRouter, {
  evidenceUploadRejectedTotal,
  evidenceUploadAcceptedTotal,
} from '../../src/routes/evidence.js'
import { EvidenceStorageService } from '../../src/services/evidence/storage.js'

// ---------------------------------------------------------------------------
// Auth mock — auth middleware is bypassed; the upload guards under test are
// the multer limits and fileFilter, not the auth layer.
// ---------------------------------------------------------------------------

vi.mock('../../src/middleware/auth.js', () => ({
  requireUserAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: 'test-user-id',
      email: 'test@example.com',
      tenantId: 'test-tenant-id',
      role: 'admin',
    }
    next()
  },
  requireAdminRole: (_req: any, _res: any, next: any) => next(),
}))

// ---------------------------------------------------------------------------
// Audit log mock — side-effect only; irrelevant to upload guard tests.
// ---------------------------------------------------------------------------

vi.mock('../../src/services/audit/index.js', () => ({
  auditLogService: { logAction: vi.fn().mockResolvedValue(undefined) },
  AuditAction: {
    EVIDENCE_UPLOADED: 'EVIDENCE_UPLOADED',
    EVIDENCE_ACCESSED: 'EVIDENCE_ACCESSED',
  },
}))

// ---------------------------------------------------------------------------
// Storage mock — lets us assert storage is NOT invoked on rejected requests.
// ---------------------------------------------------------------------------

const mockUploadEvidence = vi.fn().mockResolvedValue({
  evidence_id: 'test-id',
  encryptedBlob: 'encrypted',
  iv: 'iv',
  authTag: 'tag',
  wrappedDek: 'wrapped',
  wrappedDekIv: 'wrapped-iv',
  wrappedDekAuthTag: 'wrapped-tag',
  uploaderId: 'test-user-id',
  tenantId: 'test-tenant-id',
  createdAt: new Date(),
  kek_version: 1,
  deletedAt: null,
  legalHold: false,
  shreddedAt: null,
})

vi.mock('../../src/services/evidence/storage.js', () => ({
  EvidenceStorageService: vi.fn(function () {
    return { uploadEvidence: mockUploadEvidence, retrieveEvidence: vi.fn() }
  }),
  evidenceDB: new Map(),
}))

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/evidence', evidenceRouter)
  // Generic error handler so unhandled errors surface as JSON.
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

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

/** Minimal JPEG buffer with correct FF D8 FF magic bytes. */
function jpegBuffer(size = 1024): Buffer {
  const buf = Buffer.alloc(size)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  return buf
}

/** Minimal PDF buffer with correct %PDF magic bytes. */
function pdfBuffer(size = 1024): Buffer {
  const buf = Buffer.alloc(size)
  buf[0] = 0x25 // %
  buf[1] = 0x50 // P
  buf[2] = 0x44 // D
  buf[3] = 0x46 // F
  return buf
}

/** JPEG-named file with PNG magic bytes inside — spoofed content type. */
function spoofedJpegBuffer(): Buffer {
  const buf = Buffer.alloc(1024)
  buf[0] = 0x89
  buf[1] = 0x50
  buf[2] = 0x4e
  buf[3] = 0x47
  return buf
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.EVIDENCE_ENCRYPTION_KEY = 'a'.repeat(32)
  evidenceUploadRejectedTotal.reset()
  evidenceUploadAcceptedTotal.reset()
  vi.clearAllMocks()
})

// ===========================================================================
// 1. Oversized file — 413
// ===========================================================================

describe('POST /api/evidence/upload — file size limits', () => {
  it('rejects a file exceeding the 10 MB limit with 413', async () => {
    const app = createApp()
    const oversized = Buffer.alloc(11 * 1024 * 1024)
    oversized[0] = 0xff
    oversized[1] = 0xd8
    oversized[2] = 0xff

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', oversized, { filename: 'large.jpg', contentType: 'image/jpeg' })

    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({ error: 'PayloadTooLarge', code: 'FileTooLarge' })
    expect(res.body.message).toContain('10MB')

    // Storage must not have been touched
    expect(mockUploadEvidence).not.toHaveBeenCalled()

    // Rejection metric incremented
    const metric = await evidenceUploadRejectedTotal.get()
    expect(
      metric.values.find((v: any) => v.labels.reason === 'file_too_large')?.value,
    ).toBe(1)
  })

  it('accepts a file just under the 10 MB limit', async () => {
    const app = createApp()
    // Slightly under the raw limit to avoid multipart framing overhead
    const nearLimit = jpegBuffer(10 * 1024 * 1024 - 100)

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', nearLimit, { filename: 'near-limit.jpg', contentType: 'image/jpeg' })

    expect(res.status).not.toBe(413)
  })
})

// ===========================================================================
// 2. Disallowed content-type — 415
// ===========================================================================

describe('POST /api/evidence/upload — disallowed content-type', () => {
  it('rejects an executable MIME type with 415', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', jpegBuffer(), {
        filename: 'test.jpg',
        contentType: 'application/x-msdownload',
      })

    expect(res.status).toBe(415)
    expect(res.body).toMatchObject({
      error: 'UnsupportedMediaType',
      code: 'InvalidMimeType',
    })
    expect(res.body.message).toContain('application/x-msdownload')

    // Storage must not have been touched
    expect(mockUploadEvidence).not.toHaveBeenCalled()

    const metric = await evidenceUploadRejectedTotal.get()
    expect(
      metric.values.find((v: any) => v.labels.reason === 'invalid_mime_type')?.value,
    ).toBe(1)
  })

  it('accepts an allowlisted MIME type (image/jpeg)', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', jpegBuffer(), { filename: 'ok.jpg', contentType: 'image/jpeg' })

    expect(res.status).not.toBe(415)
  })

  it('accepts an allowlisted MIME type (application/pdf)', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', pdfBuffer(), { filename: 'ok.pdf', contentType: 'application/pdf' })

    expect(res.status).not.toBe(415)
  })
})

// ===========================================================================
// 3. Disallowed extension — 415
// ===========================================================================

describe('POST /api/evidence/upload — disallowed extension', () => {
  it('rejects a .exe extension with 415', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', jpegBuffer(), { filename: 'malware.exe', contentType: 'image/jpeg' })

    expect(res.status).toBe(415)
    expect(res.body).toMatchObject({
      error: 'UnsupportedMediaType',
      code: 'InvalidFileType',
    })
    expect(res.body.message).toContain('.exe')

    // Storage must not have been touched
    expect(mockUploadEvidence).not.toHaveBeenCalled()

    const metric = await evidenceUploadRejectedTotal.get()
    expect(
      metric.values.find((v: any) => v.labels.reason === 'invalid_extension')?.value,
    ).toBe(1)
  })

  it('rejects a file with no extension with 415', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', jpegBuffer(), { filename: 'noextension', contentType: 'image/jpeg' })

    expect(res.status).toBe(415)
    expect(res.body).toMatchObject({
      error: 'UnsupportedMediaType',
      code: 'InvalidFileType',
    })
    expect(mockUploadEvidence).not.toHaveBeenCalled()
  })

  it('accepts an allowlisted extension (.jpg)', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', jpegBuffer(), { filename: 'photo.jpg', contentType: 'image/jpeg' })

    expect(res.status).not.toBe(415)
  })
})

// ===========================================================================
// 4. Missing file — 400
// ===========================================================================

describe('POST /api/evidence/upload — missing file', () => {
  it('rejects a request with no file attached with 400', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'BadRequest', code: 'NoFiles' })
    expect(res.body.message).toContain('files')

    // Storage must not have been touched
    expect(mockUploadEvidence).not.toHaveBeenCalled()

    const metric = await evidenceUploadRejectedTotal.get()
    expect(
      metric.values.find((v: any) => v.labels.reason === 'no_files')?.value,
    ).toBe(1)
  })
})

// ===========================================================================
// 5. Spoofed content (magic-number mismatch) — 400
// ===========================================================================

describe('POST /api/evidence/upload — magic-number mismatch', () => {
  it('rejects a JPEG-declared file whose bytes are PNG with 400', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', spoofedJpegBuffer(), {
        filename: 'spoofed.jpg',
        contentType: 'image/jpeg',
      })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'BadRequest', code: 'ContentMismatch' })
    expect(res.body.message).toContain('image/jpeg')

    // Storage must not have been touched — guard fires before any write
    expect(mockUploadEvidence).not.toHaveBeenCalled()
    expect(EvidenceStorageService).not.toHaveBeenCalled()

    const metric = await evidenceUploadRejectedTotal.get()
    expect(
      metric.values.find((v: any) => v.labels.reason === 'magic_number_mismatch')?.value,
    ).toBe(1)
  })
})

// ===========================================================================
// 6. Valid upload — happy path — 201
// ===========================================================================

describe('POST /api/evidence/upload — happy path', () => {
  it('returns 201 with the storage record for a valid JPEG', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', jpegBuffer(), { filename: 'evidence.jpg', contentType: 'image/jpeg' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ evidence_id: 'test-id' })

    // Storage was invoked exactly once
    expect(mockUploadEvidence).toHaveBeenCalledOnce()

    // Accept metric incremented
    const metric = await evidenceUploadAcceptedTotal.get()
    expect(metric.values[0]?.value).toBe(1)
  })

  it('returns 201 with the storage record for a valid PDF', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', pdfBuffer(), { filename: 'evidence.pdf', contentType: 'application/pdf' })

    expect(res.status).toBe(201)
    expect(mockUploadEvidence).toHaveBeenCalledOnce()
  })
})

// ===========================================================================
// 7. Metrics
// ===========================================================================

describe('POST /api/evidence/upload — metrics', () => {
  it('increments the rejected metric with reason=file_too_large for oversized uploads', async () => {
    const app = createApp()
    const oversized = Buffer.alloc(11 * 1024 * 1024)
    oversized[0] = 0xff; oversized[1] = 0xd8; oversized[2] = 0xff

    await request(app)
      .post('/api/evidence/upload')
      .attach('files', oversized, { filename: 'big.jpg', contentType: 'image/jpeg' })

    const metric = await evidenceUploadRejectedTotal.get()
    expect(
      metric.values.find((v: any) => v.labels.reason === 'file_too_large')?.value,
    ).toBe(1)
  })

  it('increments the accepted metric on a successful upload', async () => {
    const app = createApp()

    await request(app)
      .post('/api/evidence/upload')
      .attach('files', jpegBuffer(), { filename: 'ok.jpg', contentType: 'image/jpeg' })

    const metric = await evidenceUploadAcceptedTotal.get()
    expect(metric.values[0]?.value).toBe(1)
  })
})

// ===========================================================================
// 8. Edge cases
// ===========================================================================

describe('POST /api/evidence/upload — edge cases', () => {
  it('rejects a zero-byte file with 400 (empty-file or content-mismatch)', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .attach('files', Buffer.alloc(0), { filename: 'empty.jpg', contentType: 'image/jpeg' })

    // Zero-byte JPEG fails the magic-number check (no bytes to read)
    expect(res.status).toBe(400)
    expect(mockUploadEvidence).not.toHaveBeenCalled()
  })

  it('rejects more than 5 files with 400 (too-many-files)', async () => {
    const app = createApp()
    const req = request(app).post('/api/evidence/upload')
    for (let i = 0; i < 6; i++) {
      req.attach('files', jpegBuffer(), { filename: `f${i}.jpg`, contentType: 'image/jpeg' })
    }

    const res = await req
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'BadRequest', code: 'TooManyFiles' })
    expect(mockUploadEvidence).not.toHaveBeenCalled()
  })

  it('ignores extra form fields and still processes a valid file', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/evidence/upload')
      .field('unexpectedField', 'extraValue')
      .attach('files', jpegBuffer(), { filename: 'evidence.jpg', contentType: 'image/jpeg' })

    // Extra fields must not break the upload
    expect(res.status).toBe(201)
  })
})
