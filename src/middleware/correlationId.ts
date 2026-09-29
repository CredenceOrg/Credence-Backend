import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { HEADER_CORRELATION_ID } from '../config/constants.js'

/**
 * Middleware that ensures every request carries a correlation ID.
 *
 * - If the incoming request already contains an `X-Correlation-ID` header, the
 *   value is propagated unchanged.
 * - If the header is absent (or empty), a new UUID v4 is generated.
 * - The resolved ID is stored on `req['correlationId']` so downstream handlers
 *   and middleware can read it without re-parsing headers.
 * - The ID is echoed back in the `X-Correlation-ID` response header.
 */
export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const existing =
    (req['correlationId'] as string) || req.get(HEADER_CORRELATION_ID)
  const correlationId = existing || randomUUID()

  req['correlationId'] = correlationId
  res.setHeader(HEADER_CORRELATION_ID, correlationId)

  next()
}
