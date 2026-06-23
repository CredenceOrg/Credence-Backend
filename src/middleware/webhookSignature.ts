import type { Request, Response, NextFunction } from 'express'
import { verifySignature } from '../lib/webhookVerifier.js'

export interface WebhookSignatureOptions {
  /**
   * Shared secret used to compute HMAC-SHA256 signatures.
   * Can be a fixed string or a function to resolve the secret per request.
   */
  secret: string | ((req: Request) => string | null | undefined)
  /**
   * Header name to read the signature from (default: 'x-webhook-signature').
   */
  signatureHeader?: string
  /**
   * Provide a deterministic body string for signing.
   * If omitted: string body is used as-is, otherwise JSON.stringify(req.body).
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

/**
 * Verify an incoming webhook signature using HMAC-SHA256.
 * Delegates all crypto and null-path logic to src/lib/webhookVerifier.ts.
 */
export function verifyWebhookSignature(options: WebhookSignatureOptions) {
  const signatureHeader = options.signatureHeader ?? 'x-webhook-signature'
  const getBody =
    options.getBody ??
    ((req: Request) =>
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}))

  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const secret =
        typeof options.secret === 'function' ? options.secret(req) : options.secret

      const rawSignature = extractHeader(req, signatureHeader)
      const body = getBody(req)

      const result = verifySignature(rawSignature, body, secret)

      if (!result.ok) {
        unauthorized(res)
        return
      }

      next()
    } catch {
      unauthorized(res)
    }
  }
}
