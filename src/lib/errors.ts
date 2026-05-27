/**
/**
 * Standard machine-readable error codes for the backend.
 * Use snake_case and document naming patterns here.
 */
export enum ErrorCode {
  VALIDATION_FAILED = 'validation_failed',
  FIELD_REQUIRED = 'field_required',
  INVALID_FORMAT = 'invalid_format',
  INVALID_ADDRESS = 'invalid_address',
  INSUFFICIENT_FUNDS = 'insufficient_funds',
  UNAUTHORIZED = 'unauthorized',
  FORBIDDEN = 'forbidden',
  NOT_FOUND = 'not_found',
  BATCH_SIZE_EXCEEDED = 'batch_size_exceeded',
  BATCH_SIZE_TOO_SMALL = 'batch_size_too_small',
  INTERNAL_SERVER_ERROR = 'internal_server_error',
  SERVICE_UNAVAILABLE = 'service_unavailable',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  VALUE_TOO_SMALL = 'value_too_small',
  VALUE_TOO_LARGE = 'value_too_large',
  UNEXPECTED_FIELD = 'unexpected_field',
  INVALID_TYPE = 'invalid_type',
  CONFLICT = 'conflict',
}

/**
 * Base class for all domain and API errors.
 * Ensures consistent structure: { error, code, details? }
 */
export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly code: ErrorCode = ErrorCode.INTERNAL_SERVER_ERROR,
    public readonly status: number = 500,
    public readonly details?: any
  ) {
    super(message)
    this.name = this.constructor.name
    // @ts-ignore - captureStackTrace is a Node-specific extension
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

/**
 * Specific error for validation failures (e.g. Zod).
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, ErrorCode.VALIDATION_FAILED, 400, details)
  }
}

/**
 * Specific error for resource not found.
 */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number) {
    const message = id ? `${resource} with ID ${id} not found` : `${resource} not found`
    super(message, ErrorCode.NOT_FOUND, 404)
  }
}

/**
 * Specific error for authentication failures.
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized access') {
    super(message, ErrorCode.UNAUTHORIZED, 401)
  }
}

/**
 * Specific error for permission/scope failures.
 */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden access') {
    super(message, ErrorCode.FORBIDDEN, 403)
  }
}

/**
 * Specific error for unavailable services.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string = 'Service temporarily unavailable') {
    super(message, ErrorCode.SERVICE_UNAVAILABLE, 503)
  }
}

/**
 * Specific error for resource conflicts (e.g. duplicate or already revoked).
 */
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, ErrorCode.CONFLICT, 409, details)
  }
}
