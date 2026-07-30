import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../lib/errors.js'
import { ErrorCode, getErrorCatalogEntry, getHttpStatus, isErrorCode } from '../lib/errorCatalog.js'
import { logger } from '../utils/logger.js'

const isProduction = (): boolean => process.env.NODE_ENV === 'production'

const sendInternalServerError = (res: Response): void => {
  const catalogEntry = getErrorCatalogEntry(ErrorCode.INTERNAL_SERVER_ERROR)

  res.status(getHttpStatus(catalogEntry)).json({
    error: catalogEntry.defaultMessage,
    code: catalogEntry.code,
    error_code: catalogEntry.code,
  })
}

/**
 * Global error-handling middleware for Express.
 * Standardizes all error responses to include a catalog-backed machine-readable code.
 */
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  // 1. Handle AppError (standardized domain errors)
  if (err instanceof AppError) {
    if (!isErrorCode(err.code)) {
      logger.error('Unhandled AppError with uncatalogued code:', err)
      sendInternalServerError(res)
      return
    }

    const catalogEntry = getErrorCatalogEntry(err.code)
    res.status(getHttpStatus(catalogEntry)).json(err.toJSON({
      // Production responses must not leak PII, stack traces, or chained causes
      // through bespoke messages/details. Consumers can still branch on `code`
      // (or the `error_code` alias).
      exposeMessage: !isProduction(),
      exposeDetails: !isProduction(),
    }))
    return
  }

  // 2. Handle unexpected/third-party errors without exposing internals.
  logger.error('Unhandled server error:', err)
  sendInternalServerError(res)
}
