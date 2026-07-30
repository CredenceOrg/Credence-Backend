import type { Response } from 'express'
import {
  ErrorCode as ErrorCodeRegistry,
  getErrorCatalogEntry,
  getHttpStatus,
  isErrorCode,
  type ErrorCode as ErrorCodeValue,
} from './errorCatalog.js'

export {
  DEFAULT_ERROR_LOCALE,
  ERROR_CATALOG,
  ERROR_CATALOG_BY_CODE,
  ERROR_CODE_DEPRECATIONS,
  ERROR_LOCALIZATION_CATALOG,
  getErrorCatalogEntry,
  getErrorCatalogEntryByCode,
  getLocalizedErrorMessage,
  isErrorCode,
} from './errorCatalog.js'
export type {
  ErrorCatalogEntry,
  ErrorCatalogKey,
  ErrorCategory,
  ErrorCodeDeprecation,
  ErrorLocale,
} from './errorCatalog.js'
export const ErrorCode = ErrorCodeRegistry
export type ErrorCode = ErrorCodeValue

export interface AppErrorJsonOptions {
  /** Include the original error message instead of the catalog default message. */
  readonly exposeMessage?: boolean
  /** Include structured details supplied by the caller. */
  readonly exposeDetails?: boolean
}

/**
 * Base class for all domain and API errors.
 *
 * The `code` must come from the centralized error catalog. The catalog's HTTP
 * status is treated as canonical; an explicitly supplied status must match it.
 */
export class AppError extends Error {
  public readonly code: ErrorCodeValue
  public readonly status: number
  public readonly details?: unknown

  constructor(
    message: string,
    code: ErrorCodeValue = ErrorCodeRegistry.INTERNAL_SERVER_ERROR,
    status?: number,
    details?: unknown,
    options?: ErrorOptions
  ) {
    if (!isErrorCode(code)) {
      throw new TypeError(`Unknown error code: ${String(code)}`)
    }

    const catalogEntry = getErrorCatalogEntry(code)
    if (status !== undefined && status !== catalogEntry.httpStatus) {
      throw new TypeError(
        `HTTP status ${status} does not match catalog status ${catalogEntry.httpStatus} for error code ${code}`
      )
    }

    super(message, options)
    this.name = this.constructor.name
    this.code = code
    this.status = getHttpStatus(catalogEntry)
    this.details = details

    const captureStackTrace = (Error as ErrorConstructor & {
      captureStackTrace?: (targetObject: object, constructorOpt?: Function) => void
    }).captureStackTrace

    if (captureStackTrace) {
      captureStackTrace(this, this.constructor)
    }
  }

  toJSON(options: AppErrorJsonOptions = {}) {
    const { exposeMessage = true, exposeDetails = true } = options
    const catalogEntry = getErrorCatalogEntry(this.code)

    return {
      error: exposeMessage ? this.message : catalogEntry.defaultMessage,
      code: this.code,
      error_code: this.code,
      ...(exposeDetails && this.details !== undefined ? { details: this.details } : {}),
    }
  }
}

export class CrawlerBlockedError extends AppError {
  constructor(message: string = getErrorCatalogEntry(ErrorCodeRegistry.CRAWLER_BLOCKED).defaultMessage) {
    super(message, ErrorCodeRegistry.CRAWLER_BLOCKED)
  }
}

/**
 * Specific error for validation failures (e.g. Zod).
 */
export class ValidationError extends AppError {
  constructor(
    message: string = getErrorCatalogEntry(ErrorCodeRegistry.VALIDATION_FAILED).defaultMessage,
    details?: unknown
  ) {
    super(message, ErrorCodeRegistry.VALIDATION_FAILED, undefined, details)
  }
}

/**
 * Specific error for redirect targets that fail open-redirect validation
 * (protocol-relative URLs, backslash tricks, or hosts outside the allowlist).
 */
export class UnsafeRedirectError extends AppError {
  constructor(
    message: string = getErrorCatalogEntry(ErrorCodeRegistry.UNSAFE_REDIRECT_TARGET).defaultMessage,
    details?: unknown
  ) {
    super(message, ErrorCodeRegistry.UNSAFE_REDIRECT_TARGET, undefined, details)
  }
}

/**
 * Specific error for resource not found.
 */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number) {
    const message = id ? `${resource} with ID ${id} not found` : `${resource} not found`
    super(message, ErrorCodeRegistry.NOT_FOUND)
  }
}

/**
 * Specific error for authentication failures.
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = getErrorCatalogEntry(ErrorCodeRegistry.UNAUTHORIZED).defaultMessage) {
    super(message, ErrorCodeRegistry.UNAUTHORIZED)
  }
}

/**
 * Specific error for permission/scope failures.
 */
export class TenantRequiredError extends AppError {
  constructor(message: string = getErrorCatalogEntry(ErrorCodeRegistry.TENANT_REQUIRED).defaultMessage) {
    super(message, ErrorCodeRegistry.TENANT_REQUIRED)
  }
}

/**
 * Specific error for unavailable services.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string = getErrorCatalogEntry(ErrorCodeRegistry.SERVICE_UNAVAILABLE).defaultMessage) {
    super(message, ErrorCodeRegistry.SERVICE_UNAVAILABLE)
  }
}

/**
 * Specific error for request bodies that exceed the configured size limit.
 */
export class RequestTooLargeError extends AppError {
  constructor(message: string = getErrorCatalogEntry(ErrorCodeRegistry.REQUEST_TOO_LARGE).defaultMessage) {
    super(message, ErrorCodeRegistry.REQUEST_TOO_LARGE)
  }
}

/**
 * Thrown when an optimistic-locking update is rejected because another writer
 * incremented the `version` between the caller's read and write.
 *
 * Callers should re-fetch the resource, re-apply their change, and retry.
 */
export class OptimisticLockError extends AppError {
  /** The address (or identifier) of the resource that conflicted. */
  public readonly resourceAddress: string
  /** The version the caller expected to find. */
  public readonly expectedVersion: number

  constructor(resourceAddress: string, expectedVersion: number) {
    super(
      `Optimistic lock conflict: resource "${resourceAddress}" was modified by another writer (expected version ${expectedVersion}). Re-fetch and retry.`,
      ErrorCodeRegistry.OPTIMISTIC_LOCK_CONFLICT,
      undefined,
      { resourceAddress, expectedVersion },
    )
    this.resourceAddress = resourceAddress
    this.expectedVersion = expectedVersion
  }
}

/**
 * Specific error for missing required security headers.
 */
export class MissingSecurityHeaderError extends AppError {
  constructor(
    message: string = getErrorCatalogEntry(ErrorCodeRegistry.MISSING_SECURITY_HEADER).defaultMessage,
    details?: unknown
  ) {
    super(message, ErrorCodeRegistry.MISSING_SECURITY_HEADER, undefined, details)
  }
}

/**
 * Send a structured error response using the centralized error catalog.
 *
 * This is a convenience helper for route handlers that need to return an
 * error directly (rather than throwing an AppError through next()). It
 * produces the same `{ error, code, error_code, details? }` envelope as
 * the global error-handler middleware.
 *
 * In production, only the catalog default message is returned (no PII).
 *
 * @param statusOverride - Optional HTTP status override. When provided, the
 *   response uses this status instead of the catalog default. Use sparingly
 *   to preserve backward compatibility with existing API contracts.
 */
export function sendError(
  res: Response,
  code: ErrorCodeValue,
  message?: string,
  details?: unknown,
  statusOverride?: number,
): void {
  const catalogEntry = getErrorCatalogEntry(code)
  const status = statusOverride ?? getHttpStatus(catalogEntry)
  const isProduction = process.env.NODE_ENV === 'production'

  res.status(status).json({
    error: isProduction ? catalogEntry.defaultMessage : (message ?? catalogEntry.defaultMessage),
    code: catalogEntry.code,
    error_code: catalogEntry.code,
    ...(!isProduction && details !== undefined ? { details } : {}),
  })
}
