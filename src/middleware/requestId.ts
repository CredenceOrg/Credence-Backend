import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { tracingContext } from '../utils/logger.js'

/**
 * Middleware to handle Request ID, Correlation ID, and context for distributed tracing.
 */
export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // 1. Handle Correlation ID
  const correlationId = req.header('x-correlation-id') || randomUUID()

  // 2. Handle Request ID
  const requestId = randomUUID()

  // 3. Attach IDs to the request object
  req['correlationId'] = correlationId
  req['requestId'] = requestId

  // 4. Return IDs in response headers
  res.setHeader('x-correlation-id', correlationId)
  res.setHeader('x-request-id', requestId)

  // 5. Wrap the rest of the request in a tracing context
  const context = new Map<string, string>()
  context.set('correlationId', correlationId)
  context.set('requestId', requestId)

  // Set standardized observability fields
  context.set('route', req.originalUrl || req.path || 'N/A')

  // Actor and tenant are extracted from headers or generic auth objects.
  // Replace `(req as any).user` with your actual auth extraction logic if different.
  const tenantId =
    (req.header('x-tenant-id') as string) ||
    (req as any).user?.tenantId ||
    'N/A'
  const actorId =
    (req.header('x-actor-id') as string) || (req as any).user?.id || 'N/A'

  context.set('tenant', tenantId)
  context.set('actor', actorId)

  tracingContext.run(context, () => {
    next()
  })
}
