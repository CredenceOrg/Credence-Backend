import { Request, Response, NextFunction } from 'express'
import { HEADER_CLIENT_VERSION } from '../config/constants.js'

/**
 * Middleware that echoes the X-Client-Version header from the request
 * back in the response headers. This aids debugging by confirming
 * what client version the server observed.
 */
export function clientVersionEchoMiddleware(req: Request, res: Response, next: NextFunction): void {
  const clientVersion = req.get(HEADER_CLIENT_VERSION)
  if (clientVersion) {
    res.setHeader(HEADER_CLIENT_VERSION, clientVersion)
  }
  next()
}
