import { Request, Response, NextFunction } from 'express'
import { MissingSecurityHeaderError } from '../lib/errors.js'

export interface SecurityHeaderCheckResult {
  missing: string[]
  present: string[]
}

export function checkSecurityHeaders(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const isProduction = process.env.NODE_ENV === 'production'
  const cspHeader = isProduction
    ? 'content-security-policy-report-only'
    : 'content-security-policy'

  const requiredHeaders = [
    cspHeader,
    'strict-transport-security',
    'referrer-policy',
    'cross-origin-resource-policy',
    'x-content-type-options',
  ]

  const missing: string[] = []

  for (const header of requiredHeaders) {
    if (!res.getHeader(header)) {
      missing.push(header)
    }
  }

  if (missing.length > 0) {
    return next(
      new MissingSecurityHeaderError(
        `Missing required security headers: ${missing.join(', ')}`,
        missing
      )
    )
  }

  next()
}