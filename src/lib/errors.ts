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
export class ForbiddenError extends AppError {
  constructor(message: string = getErrorCatalogEntry(ErrorCodeRegistry.FORBIDDEN).defaultMessage) {
    super(message, ErrorCodeRegistry.FORBIDDEN)
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
