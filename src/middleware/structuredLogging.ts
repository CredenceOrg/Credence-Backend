import { Request, Response, NextFunction } from 'express'
import { logger, tracingContext } from '../utils/logger.js'
import { LogEventType } from '../observability/logSchemas.js'

/**
 * Structured logging middleware — issue #987
 *
 * Emits a single `http:request` log entry **after** the response is finished
 * so all four standard observability fields are fully resolved:
 *
 *   - `route`         — matched Express route template, e.g. `/api/trust/:address`
 *   - `tenant`        — tenant identifier from the active tracing context
 *   - `actor`         — actor identifier from the active tracing context
 *   - `correlationId` — distributed trace ID propagated via `X-Correlation-ID`
 *
 * The log entry is emitted with the `HTTP_REQUEST` event type so the
 * allowlist-based redaction layer in `src/observability/logSchemas.ts` strips
 * any accidental PII before serialisation.
 *
 * Placement: mount **after** `requestIdMiddleware` and `correlationIdMiddleware`
 * so that the tracing context is already populated when the middleware runs.
 */
export function structuredLoggingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startMs = Date.now()

  // Snapshot the tracing context store *at middleware invocation time*.
  // The AsyncLocalStorage context is available here because this middleware
  // runs inside the tracingContext.run() call made by requestIdMiddleware.
  const store = tracingContext.getStore()

  res.on('finish', () => {
    const durationMs = Date.now() - startMs

    // Resolve the route template lazily — req.route is only populated after
    // Express has matched a handler.  We fall back to req.path so that
    // unmatched routes (404s) still produce a log entry without a raw URL
    // (which could contain PII or high-cardinality path segments).
    const routeTemplate: string =
      (req as any).route?.path ??
      (req as any).routerPath ??
      req.path ??
      'unknown'

    // Canonical IDs set by requestIdMiddleware / correlationIdMiddleware.
    const requestId: string = (req as any).requestId ?? 'N/A'
    const correlationId: string = (req as any).correlationId ?? 'N/A'

    // Resolve tenant / actor from the tracing context.  The context proxy in
    // requestIdMiddleware lazily re-reads auth fields on every .get() call, so
    // late-binding values (set after requireApiKey/JWT validation runs) are
    // included here even though we snapshotted the store reference earlier.
    const tenant = store?.get('tenant') ?? 'N/A'
    const actor = store?.get('actor') ?? 'N/A'

    logger.info(
      {
        message: `${req.method} ${routeTemplate} ${res.statusCode}`,
        method: req.method,
        path: req.path,
        route: routeTemplate,
        statusCode: res.statusCode,
        durationMs,
        requestId,
        tenant,
        actor,
        correlationId,
      },
      { eventType: LogEventType.HTTP_REQUEST },
    )
  })

  next()
}
