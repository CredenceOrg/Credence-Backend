import type { Request, Response, NextFunction } from 'express'
import type { ZodSchema, ZodError } from 'zod'
import { ValidationError, ErrorCode } from '../lib/errors.js'

/**
 * Validated request type that extends Express Request.
 * Downstream handlers can use this type to get full type safety
 * on req.validated, req.body, req.query, and req.params.
 */
export interface ValidatedRequest<
  TParams = any,
  TQuery = any,
  TBody = any,
> extends Request<TParams, any, TBody, TQuery> {
  validated: {
    params: TParams
    query: TQuery
    body: TBody
  }
}

declare global {
  namespace Express {
    interface Request {
      validated?: {
        params?: any
        query?: any
        body?: any
      }
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
 * @returns Array of { path, message, code } for client consumption
 */
export function formatZodErrors(error: ZodError): Array<{ path: string; message: string; code: string }> {
  return error.issues.map((e) => {
    let code: ErrorCode = ErrorCode.VALIDATION_FAILED
    const pathStr = e.path?.length ? e.path.join('.') : '(root)'
    const lowerPath = pathStr.toLowerCase()
    const lowerMessage = e.message.toLowerCase()

    switch (e.code) {
      case 'custom':
        if (e.message === 'INVALID_STELLAR_ADDRESS') {
          code = ErrorCode.INVALID_STELLAR_ADDRESS
        } else if (lowerMessage.includes('stellar') && lowerMessage.includes('address')) {
          code = ErrorCode.INVALID_STELLAR_ADDRESS
        } else if (lowerPath.includes('address') || lowerMessage.includes('address')) {
          code = ErrorCode.INVALID_ADDRESS
        }
        break
      case 'invalid_type':
        // If a required field is missing (value is undefined)
        if ((e as any).received === 'undefined' || lowerMessage.includes('received undefined') || lowerMessage.includes('required')) {
          code = ErrorCode.FIELD_REQUIRED
        } else {
          code = ErrorCode.INVALID_TYPE
        }
        break
      case 'invalid_format':
        // String format validations (email, uuid, etc.) in Zod 4
        if (lowerPath.includes('address') || (lowerMessage.includes('address') && !lowerMessage.includes('email'))) {
          code = ErrorCode.INVALID_ADDRESS
        } else {
          code = ErrorCode.INVALID_FORMAT
        }
        break
      case 'invalid_value':
        // Enum validation in Zod 4
        code = ErrorCode.INVALID_TYPE
        break
      case 'too_small':
        code = ErrorCode.VALUE_TOO_SMALL
        break
      case 'too_big':
        code = ErrorCode.VALUE_TOO_LARGE
        break
      case 'unrecognized_keys':
        code = ErrorCode.UNEXPECTED_FIELD
        break
    }

    return {
      path: pathStr,
      message: e.message,
      code,
    }
  })
}

/**
 * Request validation middleware using Zod schemas.
 * Validates path params, query params, and/or body per route.
 * On success, assigns validated data to req.validated and replaces
 * req.params, req.query, and req.body with the parsed/coerced/stripped versions.
 * On failure, calls next(ValidationError).
 *
 * @param options - Optional schemas for params, query, and body. Omit a key to skip that source.
 * @returns Express middleware
 */
export function validate<TParams = any, TQuery = any, TBody = any>(
  options: ValidateOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const { params: paramsSchema, query: querySchema, body: bodySchema } = options

  return (req: Request, res: Response, next: NextFunction) => {
    const validated: { params?: any; query?: any; body?: any } = {}
    const errors: Array<{ path: string; message: string; code: string }> = []

    if (paramsSchema) {
      const result = paramsSchema.safeParse(req.params)
      if (result.success) {
        validated.params = result.data
        req.params = result.data as any
      } else {
        errors.push(...formatZodErrors(result.error))
      }
    }

    if (querySchema) {
      const result = querySchema.safeParse(req.query)
      if (result.success) {
        validated.query = result.data
        req.query = result.data as any
      } else {
        errors.push(...formatZodErrors(result.error))
      }
    }

    if (bodySchema) {
      const result = bodySchema.safeParse(req.body)
      if (result.success) {
        validated.body = result.data
        req.body = result.data as any
      } else {
        errors.push(...formatZodErrors(result.error))
      }
    }

    if (errors.length > 0) {
      next(new ValidationError('Validation failed', errors))
      return
    }

    req.validated = validated as any
    next()
  }
}
