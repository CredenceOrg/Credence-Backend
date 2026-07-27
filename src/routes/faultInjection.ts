import { Router, type Request, type Response } from 'express'
import { faultInjectionRequestSchema } from '../schemas/faultInjection.js'
import { sendError, ErrorCode } from '../lib/errors.js'

export interface FaultInjectionRouterOptions {
  /** When true the fault-injection endpoint is active; otherwise it returns 404. */
  devMode: boolean
}

/**
 * Builds the fault-injection router for chaos / retry testing.
 *
 * - POST /api/dev/fault-injection -> returns the requested HTTP error status
 *   (default 500) with a structured JSON body.  Only available when DEV_MODE is
 *   enabled; returns 404 otherwise.
 *
 * This endpoint is strictly dev/test-only and must never be exposed in
 * production.
 */
export function createFaultInjectionRouter(options: FaultInjectionRouterOptions): Router {
  const router = Router()

  router.post('/', (req: Request, res: Response) => {
    if (!options.devMode) {
      sendError(res, ErrorCode.NOT_FOUND, 'Not found')
      return
    }

    const parsed = faultInjectionRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      sendError(res, ErrorCode.VALIDATION_FAILED, 'Invalid request', parsed.error.issues)
      return
    }

    const { statusCode, message } = parsed.data
    const faultMessage = message ?? `Simulated fault (HTTP ${statusCode})`

    res.status(statusCode).json({
      fault: true,
      statusCode,
      message: faultMessage,
    })
  })

  return router
}
