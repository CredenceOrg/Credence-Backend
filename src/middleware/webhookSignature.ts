import type { Request, Response, NextFunction } from 'express'
import { createHmac, timingSafeEqual } from 'crypto'

export interface WebhookSignatureOptions {
  /**
   * Shared secret used to compute HMAC-SHA256 signatures.
   *
   * Can be a fixed string or a function to resolve the secret per request.
   */
  secret: string | ((req: Request) => string | null | undefined)
  /**
   * Header name to read the signature from (default: 'x-webhook-signature').
   */
  signatureHeader?: string
  /**
   * Provide a deterministic body string for signing.
   *
   * If omitted:
   * - string body is used as-is
   * - otherwise JSON.stringify(req.body) is used
   */
  getBody?: (req: Request) => string
}

function unauthorized(res: Response): void {
  res.status(401).json({ error: 'Unauthorized' })
}

function extractHeader(req: Request, headerName: string): string | null {
  const value = req.headers[headerName.toLowerCase()]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return null
}

function normalizeSignature(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Accept either raw hex or "sha256=<hex>".
  const candidate = trimmed.toLowerCase().startsWith('sha256=')
    ? trimmed.slice('sha256='.length).trim()
    : trimmed

  if (!/^[0-9a-f]+$/i.test(candidate)) return null
  if (candidate.length !== 64) return null // SHA-256 hex

  return candidate.toLowerCase()
}

function computeSignatureHex(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false
  return timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'))
}

/**
 * Verify an incoming webhook signature using HMAC-SHA256.
 *
 * On missing/invalid signatures, responds with 401 and a generic body to avoid
 * leaking parsing details.
 */
export function verifyWebhookSignature(options: WebhookSignatureOptions) {
  const signatureHeader = options.signatureHeader ?? 'x-webhook-signature'
  const getBody =
    options.getBody ??
    ((req: Request) => (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})))

  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const secret =
        typeof options.secret === 'function' ? options.secret(req) : options.secret

      if (!secret) {
        unauthorized(res)
        return
      }

      const headerValue = extractHeader(req, signatureHeader)
      if (!headerValue) {
        unauthorized(res)
        return
      }

      const received = normalizeSignature(headerValue)
      if (!received) {
        unauthorized(res)
        return
      }

      const body = getBody(req)
      const expected = computeSignatureHex(body, secret)

      if (!timingSafeEqualHex(expected, received)) {
        unauthorized(res)
        return
      }

      next()
    } catch {
      unauthorized(res)
    }
  }
}

