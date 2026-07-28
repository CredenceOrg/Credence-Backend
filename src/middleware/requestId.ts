import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { tracingContext, createRequestLogger } from '../utils/logger.js'
import { HEADER_CORRELATION_ID } from '../config/constants.js'

/**
 * Middleware to handle Request ID, Correlation ID, Trace ID, and context for distributed tracing.
 */
export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // 1. Handle Correlation ID — prefer value already set by correlationIdMiddleware
  const correlationId = (req['correlationId'] as string) || req.header(HEADER_CORRELATION_ID) || randomUUID()
  req['correlationId'] = correlationId

  // 2. Handle Request ID
  const requestId = (req.header('x-request-id') as string) || randomUUID()

  // 3. Handle Trace ID - reuse from incoming header or generate a new one
  const traceId = (req.header('x-trace-id') as string) || randomUUID()

  // 4. Attach IDs to the request object
  req['correlationId'] = correlationId
  req['requestId'] = requestId
  req['traceId'] = traceId

  // 5. Return IDs in response headers
  res.setHeader('x-correlation-id', correlationId)
  res.setHeader('x-request-id', requestId)
  res.setHeader('x-trace-id', traceId)

  // 6. Wrap the rest of the request in a tracing context
  const context = new Map<string, string>()
  context.set('correlationId', correlationId)
  context.set('requestId', requestId)
  context.set('traceId', traceId)

  // Set standardized observability fields.
  // Use the matched route template (e.g. /api/trust/:address) rather than the
  // full raw URL which may contain sensitive path parameters or query strings.
  // req.route is only available after the route handler has been matched, so we
  // resolve it lazily via the context proxy below.
  context.set('route', req.route?.path || req.path || 'N/A')

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

  const contextProxy = new Proxy(context, {
    get(target, prop) {
      if (prop === 'get') {
        return (key: string) => {
          if (key === 'tenant') {
            const val = target.get('tenant')
            if (val && val !== 'N/A') return val
            return (
              (req.header('x-tenant-id') as string) ||
              (req as any).user?.tenantId ||
              'N/A'
            )
          }
          if (key === 'actor') {
            const val = target.get('actor')
            if (val && val !== 'N/A') return val
            return (
              (req.header('x-actor-id') as string) ||
              (req as any).user?.id ||
              'N/A'
            )
          }
          if (key === 'route') {
            // Lazily resolve the matched route template once Express has
            // populated req.route.  This avoids logging raw URLs (which may
            // contain path parameters or query strings with sensitive data)
            // and keeps cardinality bounded to distinct route patterns.
            const routeTemplate: string | undefined =
              (req as any).route?.path ??
              (req as any).routerPath ??
              undefined
            if (routeTemplate) return routeTemplate
            return target.get('route') ?? 'N/A'
          }
          return target.get(key)
        }
      }
      const value = Reflect.get(target, prop)
      if (typeof value === 'function') {
        return value.bind(target)
      }
      return value
    }
  })

  // Attach the logger to req.log
  req.log = createRequestLogger(contextProxy)

  tracingContext.run(contextProxy, () => {
    next()
  })
}
