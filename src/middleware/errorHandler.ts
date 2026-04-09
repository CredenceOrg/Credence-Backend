import type { Request, Response, NextFunction } from 'express'
import { AppError, ErrorCode } from '../lib/errors.js'

/**
 * Global error-handling middleware for Express.
 * Standardizes all error responses to include a machine-readable code.
 */
export const errorHandler = (
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  // 1. Handle AppError (standardized domain errors)
  if (err instanceof AppError) {
    res.status(err.status).json(err.toJSON())
    return
  }

  // 2. Handle unexpected errors
  console.error('Unhandled server error:', err)
  
  res.status(500).json({
    error: 'An unexpected internal server error occurred',
    code: ErrorCode.INTERNAL_SERVER_ERROR,
  })
}
