import type { Request, Response, NextFunction } from 'express'
import { ServiceUnavailableError } from '../lib/errors.js'
import { READ_ONLY_HEADER } from '../config/constants.js'

/**
 * Middleware that gracefully degrades request handling when X-Read-Only header is present.
 * It rejects write requests (POST, PUT, DELETE, PATCH) with a ServiceUnavailableError (503).
 */
export function gracefulDegradeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const readOnlyHeader = req.headers[READ_ONLY_HEADER]
  
  if (readOnlyHeader === 'true' || readOnlyHeader === '1') {
    const writeMethods = ['POST', 'PUT', 'DELETE', 'PATCH']
    if (writeMethods.includes(req.method.toUpperCase())) {
      throw new ServiceUnavailableError('Writes are temporarily disabled due to maintenance')
    }
  }
  
  next()
}
