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
 * Maps every Zod v4 issue code to a stable error catalog code.
 * @param error - ZodError from schema.safeParse()
 * @returns Array of { path, message, code } for client consumption
 */
export function formatZodErrors(error: ZodError): Array<{ path: string; message: string; code: string }> {
  return error.issues.map((e) => {
    const code = mapZodIssueCode(e)
    const pathStr = e.path?.length ? e.path.join('.') : '(root)'

    return {
      path: pathStr,
      message: e.message,
      code,
    }
  })
}

function mapZodIssueCode(issue: Record<string, unknown>): ErrorCode {
  const e = issue as Record<string, unknown>
  const code = e.code as string
  const pathArr = e.path as Array<string | number>
  const pathStr = pathArr?.length ? pathArr.join('.') : '(root)'
  const lowerPath = pathStr.toLowerCase()
  const lowerMessage = (e.message as string)?.toLowerCase() ?? ''

  switch (code) {
    case 'invalid_type': {
      const received = e.received as string | undefined
      if (
        received === 'undefined' ||
        lowerMessage.includes('received undefined') ||
        lowerMessage.includes('required')
      ) {
        return ErrorCode.FIELD_REQUIRED
      }
      return ErrorCode.INVALID_TYPE
    }

    case 'invalid_value':
    case 'invalid_literal':
    case 'invalid_enum_value':
      return ErrorCode.INVALID_TYPE

    case 'invalid_string':
    case 'invalid_format': {
      if (
        lowerPath.includes('address') ||
        (lowerMessage.includes('address') && !lowerMessage.includes('email'))
      ) {
        return ErrorCode.INVALID_ADDRESS
      }
      return ErrorCode.INVALID_FORMAT
    }

    case 'invalid_date':
      return ErrorCode.INVALID_FORMAT

    case 'invalid_union':
    case 'invalid_union_discriminator':
      return ErrorCode.INVALID_TYPE

    case 'invalid_arguments':
    case 'invalid_return_type':
      return ErrorCode.VALIDATION_FAILED

    case 'too_small':
      return ErrorCode.VALUE_TOO_SMALL

    case 'too_big':
      return ErrorCode.VALUE_TOO_LARGE

    case 'unrecognized_keys':
      return ErrorCode.UNEXPECTED_FIELD

    case 'not_multiple_of':
      return ErrorCode.INVALID_FORMAT

    case 'invalid_key':
      return ErrorCode.INVALID_FORMAT

    case 'custom': {
      const message = e.message as string
      if (message === 'INVALID_STELLAR_ADDRESS') {
        return ErrorCode.INVALID_STELLAR_ADDRESS
      }
      if (lowerMessage.includes('stellar') && lowerMessage.includes('address')) {
        return ErrorCode.INVALID_STELLAR_ADDRESS
      }
      if (lowerPath.includes('address') || lowerMessage.includes('address')) {
        return ErrorCode.INVALID_ADDRESS
      }
      return ErrorCode.VALIDATION_FAILED
    }

    default:
      return ErrorCode.VALIDATION_FAILED
  }
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
): (req: ValidatedRequest<TParams, TQuery, TBody>, res: Response, next: NextFunction) => void {
  const { params: paramsSchema, query: querySchema, body: bodySchema } = options

  return (req: ValidatedRequest<TParams, TQuery, TBody>, res: Response, next: NextFunction) => {
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
