import type { Request, Response, NextFunction } from 'express'
import type { ZodSchema, ZodError } from 'zod'
import { ValidationError } from '../lib/errors.js'

/**
 * Validated request payload.
 * Attached to `req.validated` when validation passes.
 */
export interface ValidatedRequest<
  TParams = unknown,
  TQuery = unknown,
  TBody = unknown,
> {
  params?: TParams
  query?: TQuery
  body?: TBody
}

declare global {
  namespace Express {
    interface Request {
      validated?: ValidatedRequest
    }
  }
}

/** Options for the validate middleware. Each key is optional. */
export interface ValidateOptions {
  /** Schema for req.params (path parameters) */
  params?: ZodSchema
  /** Schema for req.query (query string) */
  query?: ZodSchema
  /** Schema for req.body (JSON body) */
  body?: ZodSchema
}

/**
 * Format Zod errors into a consistent structure.
 * @param error - ZodError from schema.safeParse()
 * @returns Array of { path, message } for client consumption
 */
function formatZodErrors(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((e) => ({
    path: e.path?.length ? e.path.join('.') : '(root)',
    message: e.message,
  }))
}

/**
 * Request validation middleware using Zod schemas.
 * Validates path params, query params, and/or body per route.
 * On success, assigns validated data to req.validated and calls next().
 * On failure, calls next(ValidationError).
 *
 * @param options - Optional schemas for params, query, and body. Omit a key to skip that source.
 * @returns Express middleware
 */
export function validate<TParams = unknown, TQuery = unknown, TBody = unknown>(
  options: ValidateOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const { params: paramsSchema, query: querySchema, body: bodySchema } = options

  return (req: Request, res: Response, next: NextFunction) => {
    const validated: ValidatedRequest<TParams, TQuery, TBody> = {}
    const errors: Array<{ path: string; message: string }> = []

    if (paramsSchema) {
      const result = paramsSchema.safeParse(req.params)
      if (result.success) {
        validated.params = result.data as TParams
      } else {
        errors.push(...formatZodErrors(result.error))
      }
    }

    if (querySchema) {
      const result = querySchema.safeParse(req.query)
      if (result.success) {
        validated.query = result.data as TQuery
      } else {
        errors.push(...formatZodErrors(result.error))
      }
    }

    if (bodySchema) {
      const result = bodySchema.safeParse(req.body)
      if (result.success) {
        validated.body = result.data as TBody
      } else {
        errors.push(...formatZodErrors(result.error))
      }
    }

    if (errors.length > 0) {
      // Throw ValidationError to be caught by global errorHandler
      next(new ValidationError('Validation failed', errors))
      return
    }

    req.validated = validated
    next()
  }
}
