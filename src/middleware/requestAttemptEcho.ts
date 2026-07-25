import { Request, Response, NextFunction } from 'express'
import { HEADER_REQUEST_ATTEMPT } from '../config/constants.js'

/**
 * Middleware that echoes the x-request-attempt header from the request
 * back in the response headers. This helps clients debug their retry
 * loops by confirming what attempt number the server observed.
 */
export function requestAttemptEchoMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestAttempt = req.get(HEADER_REQUEST_ATTEMPT)
  if (requestAttempt) {
    res.setHeader(HEADER_REQUEST_ATTEMPT, requestAttempt)
  }
  next()
}