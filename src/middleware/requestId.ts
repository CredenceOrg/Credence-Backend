import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'

/**
 * Middleware to handle Request ID and Correlation ID for distributed tracing.
 */
export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // 1. Handle Correlation ID: Use existing or generate new for cross-service tracing
  const correlationId = req.header('x-correlation-id') || randomUUID()

  // 2. Handle Request ID: Unique ID for this specific request
  const requestId = randomUUID()

  // 3. Attach IDs to the request object (for use in the app)
  req['correlationId'] = correlationId
  req['requestId'] = requestId

  // 4. Return IDs in response headers so clients can report them in bug reports
  res.setHeader('x-correlation-id', correlationId)
  res.setHeader('x-request-id', requestId)

  next()
}
