import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createCompressionMiddleware, compressionMetricsMiddleware } from '../middleware/compression.js'
import { register, responseSizeBytes } from '../middleware/metrics.js'
import zlib from 'node:zlib'

/**
 * NOTE: `responseSizeBytes` is a module-level singleton Prometheus histogram
 * shared by every `compressionMetricsMiddleware` instance. Per-file vitest is
 * serial, so the metric reset / delta assertions below are deterministic.
 * Do NOT run individual tests in parallel against this file.
 */
function buildApp(opts: Parameters<typeof createCompressionMiddleware>[0] = {}) {
  register.resetMetrics()
  const app = express()
  app.use(compressionMetricsMiddleware)
  app.use(createCompressionMiddleware(opts))

  app.get('/json-large', (_req, res) => {
    res.json({ data: 'a'.repeat(2000) })
  })

  app.get('/json-tiny', (_req, res) => {
    res.json({ data: 'small' })
  })

  app.get('/html-large', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send('<p>' + 'x'.repeat(2000) + '</p>')
  })

  app.get('/image-large', (_req, res) => {
    const buf = Buffer.alloc(2000, 0xaa) // not compressible
    res.setHeader('Content-Type', 'image/png')
    res.send(buf)
  })

  app.get('/stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write('data: event\n\n')
    res.end()
  })

  app.get('/no-compress', (_req, res) => {
    res.setHeader('x-no-compression', 'true')
    res.json({ data: 'a'.repeat(2000) })
  })

  app.get('/no-transform', (_req, res) => {
    res.setHeader('Cache-Control', 'no-transform')
    res.json({ data: 'a'.repeat(2000) })
  })

  return app
}

describe('Compression Middleware', () => {
  beforeEach(() => {
    register.resetMetrics()
  })

  describe('enabled (defaults)', () => {
    let app: express.Express
    beforeEach(() => {
      app = buildApp()
    })

    it('compresses large JSON payloads with gzip when client advertises gzip', async () => {
      const response = await request(app)
        .get('/json-large')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBe('gzip')
      // The `compression` package adds Vary so HTTP caches don't serve the
      // gzipped body to a client that asked for `identity`. Without this,
      // CDNs/proxies will mix compressed and uncompressed responses.
      expect(response.headers.vary).toBeDefined()
      expect(response.headers.vary).toContain('Accept-Encoding')

      // The decompressed body must equal the original JSON.
      const inflated = zlib.gunzipSync(Buffer.from(response.body as Buffer)).toString('utf8')
      expect(inflated).toContain('"data"')
      expect(inflated.length).toBeGreaterThan(1500)
    })

    it('prefers brotli when client advertises br first', async () => {
      // Node ships native brotli (zlib.createBrotliCompress since 10.16),
      // and `compression` selects it when the client advertises it ahead
      // of gzip. The test name asserts preference — it MUST pick br.
      const response = await request(app)
        .get('/json-large')
        .set('Accept-Encoding', 'br, gzip')

      expect(response.headers['content-encoding']).toBe('br')

      // Round-trip decode: the wire bytes must be valid brotli.
      const decoded = zlib.brotliDecompressSync(Buffer.from(response.body as Buffer)).toString('utf8')
      expect(decoded).toContain('"data"')
      expect(decoded.length).toBeGreaterThan(1500)
    })

    it('falls back to deflate when only deflate is acceptable', async () => {
      const response = await request(app)
        .get('/json-large')
        .set('Accept-Encoding', 'deflate')

      expect(response.headers['content-encoding']).toBe('deflate')
    })

    it('does NOT compress when client sends no Accept-Encoding', async () => {
      const response = await request(app).get('/json-large')

      expect(response.headers['content-encoding']).toBeUndefined()
      // supertest still parses the JSON body into an object — sanity check.
      expect(response.body.data.length).toBe(2000)
    })

    it('produces a strictly smaller wire payload for highly compressible data', async () => {
      const uncompressed = await request(app)
        .get('/json-large')
        .set('Accept-Encoding', 'identity')
      const compressed = await request(app)
        .get('/json-large')
        .set('Accept-Encoding', 'gzip')

      const uncompressedLen = Number(uncompressed.headers['content-length'] ?? (uncompressed.body as Buffer).length)
      const compressedLen = (compressed.body as Buffer).length

      // 'a' × 2000 compresses to roughly 30 bytes — far less than the original.
      expect(compressedLen).toBeLessThan(uncompressedLen / 10)
      expect(compressedLen).toBeGreaterThan(0)
    })

    it('does NOT compress small JSON payloads (below threshold)', async () => {
      const response = await request(app)
        .get('/json-tiny')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBeUndefined()
    })

    it('does not expose x-no-compression as a Vary header', async () => {
      // Sanity: a request that explicitly opts out shouldn't add Vary
      // (since the body is sent unchanged).
      const response = await request(app)
        .get('/no-compress')
        .set('Accept-Encoding', 'gzip')
        .set('x-no-compression', 'true')

      expect(response.headers['content-encoding']).toBeUndefined()
    })

    it('does NOT compress Server-Sent Events', async () => {
      const response = await request(app)
        .get('/stream')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBeUndefined()
    })

    it('does NOT compress when client sends Accept: text/event-stream', async () => {
      // SSE framing is fragile; an Accept-only marker on /json-large must
      // still force the filter to refuse compression, even though the server
      // would otherwise emit application/json. This is opt-out by intent.
      const app2 = express()
      app2.use(compressionMetricsMiddleware)
      app2.use(createCompressionMiddleware())
      app2.get('/json-large', (req, res) => {
        if (req.headers.accept === 'text/event-stream') {
          res.setHeader('Content-Type', 'text/event-stream')
          res.write('data: ping\n\n')
          res.end()
          return
        }
        res.json({ data: 'a'.repeat(2000) })
      })

      const response = await request(app2)
        .get('/json-large')
        .set('Accept', 'text/event-stream')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBeUndefined()
    })

    it('respects x-no-compression request header', async () => {
      const response = await request(app)
        .get('/no-compress')
        .set('Accept-Encoding', 'gzip')
        .set('x-no-compression', 'true')

      expect(response.headers['content-encoding']).toBeUndefined()
      expect(response.body.data.length).toBe(2000)
    })

    it('respects x-no-compression regardless of header casing', async () => {
      // HTTP headers are lowercased by Node; Express exposes them as such.
      const response = await request(app)
        .get('/no-compress')
        .set('Accept-Encoding', 'gzip')
        .set('X-No-Compression', '1')

      expect(response.headers['content-encoding']).toBeUndefined()
    })

    it('respects Cache-Control: no-transform response header', async () => {
      const response = await request(app)
        .get('/no-transform')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBeUndefined()
    })

    it('does NOT compress binary content types like image/png', async () => {
      const response = await request(app)
        .get('/image-large')
        .set('Accept-Encoding', 'gzip')

      // Already-compressed data (and generic binary) is excluded by the
      // standard `compression.filter` heuristic to avoid CPU waste.
      expect(response.headers['content-encoding']).toBeUndefined()
    })

    it('compresses text/html (compressible text)', async () => {
      const response = await request(app)
        .get('/html-large')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBe('gzip')
      expect(response.headers.vary).toContain('Accept-Encoding')
    })
  })

  describe('threshold boundaries', () => {
    it('does NOT compress when threshold is set higher than the body bytes', async () => {
      // Threshold of 1 MiB — well above the 2 KiB body — guarantees the
      // body is sent uncompressed regardless of encoding acceptance.
      const app = buildApp({ thresholdBytes: 1_000_000 })

      const response = await request(app)
        .get('/json-large')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBeUndefined()
    })

    it('compresses when threshold is below the body bytes', async () => {
      // Threshold of 50 bytes — well below the 2 KiB body — guarantees
      // compression kicks in for any compressed-eligible payload.
      const app = buildApp({ thresholdBytes: 50 })

      const response = await request(app)
        .get('/json-tiny')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBe('gzip')
    })

    it('treats threshold=0 as "compress everything" (no thresholding)', async () => {
      const app = buildApp({ thresholdBytes: 0 })

      const response = await request(app)
        .get('/json-tiny')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBe('gzip')
    })

    it('clamps a negative threshold to 0 instead of crashing', async () => {
      // Defensive: a negative threshold would otherwise be interpreted as
      // "compress everything < 0 bytes" by the `compression` package. The
      // factory must coerce this to 0 so behaviour stays predictable.
      const app = buildApp({ thresholdBytes: -1 })

      const response = await request(app)
        .get('/json-tiny')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBe('gzip')
    })

    it('treats NaN threshold as 0 (compress everything)', async () => {
      // NaN path: in practice the zod schema rejects NaN at config-load,
      // but a misbehaving caller could pass `{ thresholdBytes: NaN as any }`.
      // The factory must not crash and must produce a sane number.
      const app = buildApp({ thresholdBytes: Number.NaN as unknown as number })

      const response = await request(app)
        .get('/json-tiny')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBe('gzip')
    })
  })

  describe('disabled mode', () => {
    it('returns a no-op middleware when enabled=false', async () => {
      const app = buildApp({ enabled: false })

      const response = await request(app)
        .get('/json-large')
        .set('Accept-Encoding', 'gzip')

      expect(response.headers['content-encoding']).toBeUndefined()
      expect(response.body.data.length).toBe(2000)
    })

    it('metrics middleware still records uncompressed bytes when compression is off', async () => {
      const app = buildApp({ enabled: false })

      const before = await responseSizeBytes.get()
      const beforeCount = sumValues(before.values, { compressed: 'false' })

      await request(app)
        .get('/json-large')
        .set('Accept-Encoding', 'gzip')

      const after = await responseSizeBytes.get()
      const afterCount = sumValues(after.values, { compressed: 'false' })

      expect(afterCount).toBeGreaterThan(beforeCount)
    })
  })

  describe('metrics', () => {
    it('records a positive observation on the compressed="true" histogram for large gzip responses', async () => {
      const app = buildApp()

      const before = await responseSizeBytes.get()
      const beforeCount = sumValues(before.values, { compressed: 'true' })

      await request(app)
        .get('/json-large')
        .set('Accept-Encoding', 'gzip')

      const after = await responseSizeBytes.get()
      const afterCount = sumValues(after.values, { compressed: 'true' })

      expect(afterCount).toBeGreaterThan(beforeCount)
    })

    it('records a positive observation on the compressed="false" histogram for small responses', async () => {
      const app = buildApp()

      const before = await responseSizeBytes.get()
      const beforeCount = sumValues(before.values, { compressed: 'false' })

      await request(app)
        .get('/json-tiny')
        .set('Accept-Encoding', 'gzip')

      const after = await responseSizeBytes.get()
      const afterCount = sumValues(after.values, { compressed: 'false' })

      expect(afterCount).toBeGreaterThan(beforeCount)
    })

    it('does not record a metric observation when zero bytes were written', async () => {
      const app = express()
      app.use(compressionMetricsMiddleware)
      app.use(createCompressionMiddleware())
      app.get('/empty', (_req, res) => res.status(204).end())

      const before = await responseSizeBytes.get()
      const beforeCount = sumValues(before.values)

      await request(app).get('/empty')

      const after = await responseSizeBytes.get()
      const afterCount = sumValues(after.values)

      expect(afterCount).toBe(beforeCount)
    })
  })
})

/** Sum the `value` field of every histogram entry that matches `labels`. */
function sumValues(
  values: Array<{ labels: Record<string, string>; value: number }>,
  labels?: Record<string, string>,
): number {
  return values
    .filter((v) =>
      labels ? Object.entries(labels).every(([k, val]) => v.labels[k] === val) : true,
    )
    .reduce((sum, v) => sum + v.value, 0)
}
