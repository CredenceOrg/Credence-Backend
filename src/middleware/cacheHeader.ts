import { Request, Response, NextFunction } from 'express'
import { cacheContext } from '../utils/cacheContext.js'
import { HEADER_X_CACHE } from '../config/constants.js'

/**
 * Middleware that initializes the cache status context for the request
 * and appends the x-cache header to the response if any cache operations occurred.
 */
export function cacheHeaderMiddleware(req: Request, res: Response, next: NextFunction): void {
  const store = { status: null }

  const originalEnd = res.end.bind(res)

  ;(res as any).end = function patchedEnd(...args: unknown[]) {
    if (!res.headersSent && store.status) {
      res.setHeader(HEADER_X_CACHE, store.status)
    }
    return (originalEnd as (...a: unknown[]) => Response)(...args)
  }

  cacheContext.run(store, () => {
    next()
  })
}
