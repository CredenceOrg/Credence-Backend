import helmet, { type HelmetOptions } from 'helmet'
import { Request, Response, NextFunction } from 'express'

/**
 * Security headers middleware using helmet.
 * Configures strict security headers for API traffic with support for per-route overrides.
 * 
 * Features:
 * - Content Security Policy with no unsafe-inline
 * - HSTS (HTTP Strict Transport Security) with preload in production
 * - Referrer Policy
 * - Cross-Origin Resource Policy
 * - Per-route override capability via res.locals
 */
const getSecurityHeadersMiddleware = () => helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      // Block unsafe-inline and unsafe-eval
      scriptSrcAttr: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: process.env.NODE_ENV === 'production',
  },
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin',
  },
  crossOriginResourcePolicy: {
    policy: 'same-origin',
  },
  // Disable other features not needed for API-only service
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  dnsPrefetchControl: false,
  frameguard: false, // API doesn't use frames
  hidePoweredBy: true,
  ieNoOpen: false,
  noSniff: true,
  permittedCrossDomainPolicies: false,
  xssFilter: false, // Deprecated in favor of CSP
})

let cachedMiddleware: any = null
let lastEnv: string | undefined = undefined

export const securityHeadersMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!cachedMiddleware || lastEnv !== process.env.NODE_ENV) {
    lastEnv = process.env.NODE_ENV
    cachedMiddleware = getSecurityHeadersMiddleware()
  }
  return cachedMiddleware(req, res, next)
}

/**
 * Middleware to allow per-route override of security headers.
 * Routes can set res.locals.securityHeaders to customize or disable specific headers.
 * 
 * Example:
 * app.use('/api/docs', (req, res, next) => {
 *   res.locals.securityHeaders = {
 *     contentSecurityPolicy: false,
 *   }
 *   next()
 * }, securityHeadersMiddleware)
 */
export const securityHeadersWithOverride = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const overrides = res.locals.securityHeaders as
    | {
        contentSecurityPolicy?: boolean | Record<string, unknown>
        hsts?: boolean | Record<string, unknown>
        referrerPolicy?: boolean | Record<string, unknown>
        crossOriginResourcePolicy?: boolean | Record<string, unknown>
      }
    | undefined

  if (!overrides) {
    return securityHeadersMiddleware(req, res, next)
  }

  // Apply helmet with overrides. Use a mutable HelmetOptions object; helmet's
  // call signature accepts Readonly<HelmetOptions>, and a mutable value is
  // assignable to it.
  const helmetConfig: HelmetOptions = {}

  if (overrides.contentSecurityPolicy !== undefined) {
    helmetConfig.contentSecurityPolicy = overrides.contentSecurityPolicy
  } else {
    helmetConfig.contentSecurityPolicy = {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        scriptSrcAttr: ["'none'"],
      },
    }
  }

  if (overrides.hsts !== undefined) {
    helmetConfig.hsts = overrides.hsts
  } else {
    helmetConfig.hsts = {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: process.env.NODE_ENV === 'production',
    }
  }

  if (overrides.referrerPolicy !== undefined) {
    helmetConfig.referrerPolicy = overrides.referrerPolicy
  } else {
    helmetConfig.referrerPolicy = {
      policy: 'strict-origin-when-cross-origin',
    }
  }

  if (overrides.crossOriginResourcePolicy !== undefined) {
    helmetConfig.crossOriginResourcePolicy = overrides.crossOriginResourcePolicy
  } else {
    helmetConfig.crossOriginResourcePolicy = {
      policy: 'same-origin',
    }
  }

  // Standard defaults
  helmetConfig.crossOriginEmbedderPolicy = false
  helmetConfig.crossOriginOpenerPolicy = false
  helmetConfig.dnsPrefetchControl = false
  helmetConfig.frameguard = false
  helmetConfig.hidePoweredBy = true
  helmetConfig.ieNoOpen = false
  helmetConfig.noSniff = true
  helmetConfig.permittedCrossDomainPolicies = false
  helmetConfig.xssFilter = false

  return helmet(helmetConfig)(req, res, next)
}
