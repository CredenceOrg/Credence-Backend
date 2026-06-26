import fs from 'fs'
import path from 'path'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import {
  AppError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from './errors.js'
import {
  ERROR_CATALOG,
  ERROR_CATALOG_BY_CODE,
  ERROR_CODE_DEPRECATIONS,
  ERROR_LOCALIZATION_CATALOG,
  getErrorCatalogEntry,
  getErrorCatalogEntryByCode,
  getLocalizedErrorMessage,
  isErrorCode,
} from './errorCatalog.js'
import { errorHandler } from '../middleware/errorHandler.js'

const STABLE_ERROR_CODE_CONTRACT = Object.freeze([
  'validation_failed',
  'field_required',
  'invalid_format',
  'invalid_address',
  'value_too_small',
  'value_too_large',
  'unexpected_field',
  'invalid_type',
  'batch_size_too_small',
  'batch_size_exceeded',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'insufficient_funds',
  'rate_limit_exceeded',
  'internal_server_error',
  'service_unavailable',
] as const)

const activeCodes = (): string[] => Object.values(ERROR_CATALOG)
  .filter((entry) => entry.kind === 'api')
  .map((entry) => entry.code)

const withNodeEnv = async <T>(nodeEnv: string, fn: () => Promise<T>): Promise<T> => {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = nodeEnv
  try {
    return await fn()
  } finally {
    if (original === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = original
    }
  }
}

const makeErrorApp = (thrower: (req: Request, res: Response, next: NextFunction) => void) => {
  const app = express()
  app.get('/test', thrower)
  app.use(errorHandler)
  return app
}

describe('error catalog registry', () => {
  it('is frozen at the registry and entry level', () => {
    expect(Object.isFrozen(ERROR_CATALOG)).toBe(true)
    expect(Object.isFrozen(ERROR_CATALOG.VALIDATION_FAILED)).toBe(true)
    expect(Object.isFrozen(ErrorCode)).toBe(true)
    expect(Object.isFrozen(ERROR_CATALOG_BY_CODE)).toBe(true)
  })

  it('exports ErrorCode constants directly from catalog entries', () => {
    for (const [key, entry] of Object.entries(ERROR_CATALOG)) {
      expect(ErrorCode[key as keyof typeof ErrorCode]).toBe(entry.code)
      expect(ERROR_CATALOG_BY_CODE[entry.code as keyof typeof ERROR_CATALOG_BY_CODE]).toBe(entry)
    }
  })

  it('contains unique machine-readable code strings', () => {
    const codes = activeCodes()
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('provides a complete default English localization catalog', () => {
    for (const entry of Object.values(ERROR_CATALOG)) {
      expect(ERROR_LOCALIZATION_CATALOG.en[entry.code as ErrorCode]).toBe(entry.defaultMessage)
      expect(getLocalizedErrorMessage(entry.code as ErrorCode)).toBe(entry.defaultMessage)
    }

    expect(getLocalizedErrorMessage(ErrorCode.NOT_FOUND, 'fr' as never)).toBe(
      ERROR_CATALOG.NOT_FOUND.defaultMessage
    )
  })

  it('validates dynamically supplied code values', () => {
    expect(isErrorCode('not_found')).toBe(true)
    expect(getErrorCatalogEntryByCode('not_found')).toEqual(getErrorCatalogEntry(ErrorCode.NOT_FOUND))
    expect(isErrorCode('not-a-real-code')).toBe(false)
    expect(getErrorCatalogEntryByCode('not-a-real-code')).toBeUndefined()
  })
})

describe('stable error-code contract', () => {
  it('does not remove or rename stable codes without a deprecation entry', () => {
    const currentCodes = new Set(activeCodes())
    const deprecatedCodes = new Set(
      Object.values(ERROR_CODE_DEPRECATIONS).map((entry) => entry.code)
    )

    for (const code of STABLE_ERROR_CODE_CONTRACT) {
      expect(
        currentCodes.has(code) || deprecatedCodes.has(code),
        `${code} was removed or renamed without an ERROR_CODE_DEPRECATIONS entry`
      ).toBe(true)
    }
  })

  it('keeps deprecation entries actionable', () => {
    for (const entry of Object.values(ERROR_CODE_DEPRECATIONS)) {
      expect(entry.code.length).toBeGreaterThan(0)
      expect(entry.deprecatedSince).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(entry.reason.length).toBeGreaterThan(0)
      if (entry.replacement) {
        expect(isErrorCode(entry.replacement)).toBe(true)
      }
    }
  })
})

describe('AppError catalog enforcement', () => {
  it('rejects unknown dynamically constructed error codes', () => {
    expect(() => new AppError('bad code', 'made_up' as ErrorCode)).toThrow(TypeError)
  })

  it('uses the internal error code and catalog status by default', () => {
    const err = new AppError('default failure')
    expect(err.code).toBe(ErrorCode.INTERNAL_SERVER_ERROR)
    expect(err.status).toBe(ERROR_CATALOG.INTERNAL_SERVER_ERROR.httpStatus)
    expect(err.toJSON()).toEqual({
      error: 'default failure',
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
    })
  })

  it('rejects status/code mismatches so catalog statuses remain canonical', () => {
    expect(() => new AppError('wrong status', ErrorCode.NOT_FOUND, 500)).toThrow(TypeError)
  })

  it('constructs safely when captureStackTrace is unavailable', () => {
    const errorConstructor = Error as ErrorConstructor & {
      captureStackTrace?: (targetObject: object, constructorOpt?: Function) => void
    }
    const original = errorConstructor.captureStackTrace
    try {
      delete errorConstructor.captureStackTrace
      expect(new AppError('without captureStackTrace', ErrorCode.NOT_FOUND).code).toBe(ErrorCode.NOT_FOUND)
    } finally {
      errorConstructor.captureStackTrace = original
    }
  })

  it('serializes legacy code and error_code fields from the same catalog value', () => {
    const err = new ValidationError('bad input', [{ path: 'name', code: ErrorCode.FIELD_REQUIRED }])

    expect(err.toJSON()).toEqual({
      error: 'bad input',
      code: ErrorCode.VALIDATION_FAILED,
      error_code: ErrorCode.VALIDATION_FAILED,
      details: [{ path: 'name', code: ErrorCode.FIELD_REQUIRED }],
    })
    expect(new ValidationError().message).toBe(ERROR_CATALOG.VALIDATION_FAILED.defaultMessage)
  })

  it('can redact custom messages and details for production responses', () => {
    const err = new AppError(
      'Sensitive user alice@example.com failed with stack Error: boom',
      ErrorCode.INTERNAL_SERVER_ERROR,
      500,
      { email: 'alice@example.com', stack: 'Error: boom' }
    )

    expect(err.toJSON({ exposeMessage: false, exposeDetails: false })).toEqual({
      error: getErrorCatalogEntry(ErrorCode.INTERNAL_SERVER_ERROR).defaultMessage,
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
    })
  })

  it('provides catalog-backed convenience error classes', () => {
    expect(new NotFoundError('Widget').toJSON().code).toBe(ErrorCode.NOT_FOUND)
    expect(new NotFoundError('Widget', 'abc').message).toBe('Widget with ID abc not found')
    expect(new UnauthorizedError().toJSON({ exposeMessage: false }).error).toBe(
      ERROR_CATALOG.UNAUTHORIZED.defaultMessage
    )
    expect(new UnauthorizedError('custom auth failure').message).toBe('custom auth failure')
    expect(new ForbiddenError().code).toBe(ErrorCode.FORBIDDEN)
    expect(new ForbiddenError('custom forbidden').message).toBe('custom forbidden')
    expect(new ServiceUnavailableError().status).toBe(ERROR_CATALOG.SERVICE_UNAVAILABLE.httpStatus)
    expect(new ServiceUnavailableError('custom unavailable').code).toBe(ErrorCode.SERVICE_UNAVAILABLE)
  })
})

describe('error handler catalog responses', () => {
  it('uses catalog status and strips PII/details from AppError responses in production', async () => {
    await withNodeEnv('production', async () => {
      const app = makeErrorApp((_req, _res, next) => {
        next(new AppError(
          'Wallet user@example.com failed with stack trace',
          ErrorCode.INSUFFICIENT_FUNDS,
          422,
          { walletId: 'wallet_123', stack: 'stack trace' }
        ))
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(422)
      expect(res.body).toEqual({
        error: getErrorCatalogEntry(ErrorCode.INSUFFICIENT_FUNDS).defaultMessage,
        code: ErrorCode.INSUFFICIENT_FUNDS,
        error_code: ErrorCode.INSUFFICIENT_FUNDS,
      })
    })
  })

  it('maps third-party throws to the cataloged internal error response', async () => {
    const app = makeErrorApp((_req, _res, next) => {
      next(new Error('database password leaked in third-party stack'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      error: getErrorCatalogEntry(ErrorCode.INTERNAL_SERVER_ERROR).defaultMessage,
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
    })
  })

  it('falls back to internal_server_error for AppError instances with tampered uncatalogued codes', async () => {
    const app = makeErrorApp((_req, _res, next) => {
      const err = new AppError('original', ErrorCode.NOT_FOUND, 404)
      Object.defineProperty(err, 'code', { value: 'tampered_code' })
      next(err)
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(500)
    expect(res.body.code).toBe(ErrorCode.INTERNAL_SERVER_ERROR)
  })

  it('does not expose chained causes in production responses', async () => {
    await withNodeEnv('production', async () => {
      const app = makeErrorApp((_req, _res, next) => {
        const cause = new Error('low-level secret cause')
        next(new AppError('Public wrapper with sensitive context', ErrorCode.SERVICE_UNAVAILABLE, 503, undefined, { cause }))
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(503)
      expect(JSON.stringify(res.body)).not.toContain('secret')
      expect(res.body.code).toBe(ErrorCode.SERVICE_UNAVAILABLE)
    })
  })
})

describe('generated error-code documentation', () => {
  it('contains every active code and stability guidance', () => {
    const docPath = path.resolve(process.cwd(), 'docs/error-codes.md')
    const doc = fs.readFileSync(docPath, 'utf-8')

    expect(doc).toContain('generated by scripts/generate-error-docs.ts')
    expect(doc).toContain('## Stability contract')
    for (const code of activeCodes()) {
      expect(doc).toContain(`\`${code}\``)
    }
  })
})
