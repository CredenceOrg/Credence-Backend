import compression from 'compression'
import { Request, Response, NextFunction, RequestHandler } from 'express'
import { responseSizeBytes } from './metrics.js'

/**
 * Options that drive compression behavior. All values are validated upstream
 * via the zod schema in `src/config/index.ts`.
 */
export interface CompressionOptions {
  /** Master switch — when false, a no-op middleware is returned. */
  enabled: boolean
  /** Threshold in bytes: responses smaller than this are NOT compressed. */
  thresholdBytes: number
}

const DEFAULT_OPTIONS: CompressionOptions = {
  enabled: true,
  thresholdBytes: 1024,
}

/**
 * The response compression middleware. Compresses large JSON (and other
 * text) payloads when:
 *   • The response body is larger than `thresholdBytes`.
 *   • The client advertises gzip / deflate / brotli via `Accept-Encoding`.
 *   • The response does NOT opt out via `Cache-Control: no-transform`,
 *     the request `x-no-compression` header, or a `text/event-stream`
 *     Content-Type (which would corrupt SSE framing if compressed).
 *
 * Opt-outs are evaluated in this order:
 *   1. Server-Sent Events (`Accept: text/event-stream` or matching response
 *      `Content-Type`) — compression would break the framing protocol.
 *   2. Request header `x-no-compression: <anything>` — explicit per-request
 *      opt-out (case-insensitive; HTTP headers are lowercased by Node).
 *   3. Standard `compression.filter` which honors `Cache-Control: no-transform`
 *      and `Accept-Encoding` negotiation.
 *
 * Security note: this middleware adds no upper bound on the *raw* response
 * body size. Callers MUST cap response sizes upstream (e.g. via pagination
 * or result-size limits) — a multi-MiB payload that compresses to a few
 * hundred bytes is a classic "compression bomb" vector at the receiving
 * end, even though the server here never blows up.
 */
export function createCompressionMiddleware(
  options: Partial<CompressionOptions> = {},
): RequestHandler {
  const opts: CompressionOptions = { ...DEFAULT_OPTIONS, ...options }

  if (!opts.enabled) {
    // No-op passthrough: still attached so downstream code can rely on the
    // shape of the middleware stack being unchanged.
    return (_req: Request, _res: Response, next: NextFunction) => next()
  }

  // Coerce to a finite, non-negative integer before handing to `compression()`.
  // Negative values, fractional values, and NaN all collapse to 0, which the
  // `compression` package treats as "compress every compressible response
  // regardless of size".
  const raw = Number(opts.thresholdBytes)
  const safeThreshold = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0

  return compression({
    threshold: safeThreshold,
    filter: (req: Request, res: Response) => {
      // Exclude Server-Sent Events — compressing SSE frames would alter byte
      // boundaries and corrupt the protocol's `data: ...\n\n` framing.
      const accept = req.headers.accept
      const responseContentType = res.getHeader('Content-Type')
      const isSSE =
        accept === 'text/event-stream' ||
        (typeof responseContentType === 'string' &&
          responseContentType.startsWith('text/event-stream'))

      if (isSSE) return false

      // Explicit per-request opt-out via the `x-no-compression` header.
      // HTTP headers are lowercased by Node, so this works regardless of
      // client casing (`X-No-Compression`, `x-NO-COMPRESSION`, etc.).
      if (req.headers['x-no-compression'] !== undefined) return false

      // Defer to the standard filter for everything else. This honors:
      //   • `Cache-Control: no-transform`
      //   • `Accept-Encoding` negotiation (returns false for clients
      //      that don't advertise a supported encoding)
      //   • Default-content-type heuristics (built-in to `compression`)
      return compression.filter(req, res)
    },
  })
}

/**
 * The default compression middleware is the one wired into the production
 * app — it uses the default 1024-byte threshold and is enabled. Tests
 * that need different thresholds or disabled mode should construct their
 * own middleware via `createCompressionMiddleware({ ... })`.
 */
export const compressionMiddleware = createCompressionMiddleware()

/**
 * Middleware that records final response-byte sizes into a Prometheus
 * histogram, labeled by whether the response was compressed. Must be
 * installed BEFORE the compression middleware so its `res.write` /
 * `res.end` hooks wrap the originals before `compression` patches them.
 *
 * The recorded value is the byte size of the application-level payload
 * (what the route handler emitted). The label reflects whether the wire
 * response carried `Content-Encoding: gzip | br | deflate`. Operators
 * can therefore compute effective compression ratios by comparing the
 * two `compressed="true"` vs `compressed="false"` histograms.
 *
 * This function is intentionally generic and side-effect-only; it does
 * not call `next()` asynchronously and does not throw.
 */
export function compressionMetricsMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  let bytes = 0

  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)

  // `res.write` overloads: (chunk, [encoding], [cb]) or (chunk, [cb]).
  // We accept the same loose shape Express expects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.write = function (this: Response, chunk: any, ...rest: any[]): boolean {
    if (chunk != null) {
      // The second positional argument is either the encoding or a callback.
      // We only need the encoding to compute byte length for strings.
      const encoding = typeof rest[0] === 'string' ? (rest[0] as BufferEncoding) : 'utf8'
      bytes += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk, encoding)
    }
    return originalWrite(chunk, ...rest)
  }

  res.end = function (this: Response, chunk?: any, ...rest: any[]): Response {
    if (chunk != null && typeof chunk !== 'function') {
      const encoding = typeof rest[0] === 'string' ? (rest[0] as BufferEncoding) : 'utf8'
      bytes += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk, encoding)
    }

    if (bytes > 0) {
      const contentEncoding = res.getHeader('Content-Encoding')
      const isCompressed =
        contentEncoding === 'gzip' ||
        contentEncoding === 'br' ||
        contentEncoding === 'deflate'

      responseSizeBytes.observe(
        { compressed: isCompressed ? 'true' : 'false' },
        bytes,
      )
    }

    return originalEnd(chunk, ...rest)
  }

  next()
}
