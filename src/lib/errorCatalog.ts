/**
 * Central registry for public API error codes.
 *
 * Error codes are a consumer-facing contract. Add new codes freely, but do not
 * remove or rename an existing code without adding an entry to
 * ERROR_CODE_DEPRECATIONS and documenting the migration path.
 */
export type ErrorCategory =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'resource'
  | 'business'
  | 'rate_limit'
  | 'system'

export interface ErrorCatalogEntry {
  readonly code: string
  readonly httpStatus: number | null
  readonly defaultMessage: string
  readonly category?: ErrorCategory
  readonly sdkClassName?: string
  readonly kind?: 'api' | 'transport'
  readonly deprecated?: boolean
  readonly replacedBy?: string
  readonly unmappedHttpFallback?: boolean
}

export interface ErrorCodeDeprecation {
  /** Deprecated machine-readable code string. */
  readonly code: string
  /** ISO date (YYYY-MM-DD) when deprecation was announced. */
  readonly deprecatedSince: string
  /** Replacement active code, when one exists. */
  readonly replacement?: ErrorCode
  /** Human-readable migration note. */
  readonly reason: string
}

const freezeCatalog = <T extends Record<string, ErrorCatalogEntry>>(catalog: T): Readonly<T> => {
  for (const entry of Object.values(catalog)) {
    Object.freeze(entry)
  }
  return Object.freeze(catalog)
}

/**
 * Stable active error-code catalog.
 *
 * Keys are TypeScript-friendly constants; `code` values are the wire-format
 * strings sent as `error_code`/`code` in API responses.
 */
export const ERROR_CATALOG = freezeCatalog({
  VALIDATION_FAILED: {
    code: 'validation_failed',
    sdkClassName: 'ValidationFailedCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'Validation failed',
    category: 'validation',
  },
  FIELD_REQUIRED: {
    code: 'field_required',
    sdkClassName: 'FieldRequiredCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'A required field is missing',
    category: 'validation',
  },
  INVALID_FORMAT: {
    code: 'invalid_format',
    sdkClassName: 'InvalidFormatCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'The request contains a field with an invalid format',
    category: 'validation',
  },
  INVALID_ADDRESS: {
    code: 'invalid_address',
    sdkClassName: 'InvalidAddressCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'The request contains an invalid address',
    category: 'validation',
  },
  VALUE_TOO_SMALL: {
    code: 'value_too_small',
    sdkClassName: 'ValueTooSmallCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'The request contains a value below the allowed minimum',
    category: 'validation',
  },
  VALUE_TOO_LARGE: {
    code: 'value_too_large',
    sdkClassName: 'ValueTooLargeCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'The request contains a value above the allowed maximum',
    category: 'validation',
  },
  UNEXPECTED_FIELD: {
    code: 'unexpected_field',
    sdkClassName: 'UnexpectedFieldCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'The request contains an unexpected field',
    category: 'validation',
  },
  INVALID_TYPE: {
    code: 'invalid_type',
    sdkClassName: 'InvalidTypeCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'The request contains a field with an invalid type',
    category: 'validation',
  },
  INVALID_STELLAR_ADDRESS: {
    code: 'invalid_stellar_address',
    sdkClassName: 'InvalidStellarAddressCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'The request contains an invalid Stellar address',
    category: 'validation',
  },
  BATCH_SIZE_TOO_SMALL: {
    code: 'batch_size_too_small',
    sdkClassName: 'BatchSizeTooSmallCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'The batch size is below the allowed minimum',
    category: 'validation',
  },
  BATCH_SIZE_EXCEEDED: {
    code: 'batch_size_exceeded',
    sdkClassName: 'BatchSizeExceededCredenceError',
    kind: 'api',
    httpStatus: 413,
    defaultMessage: 'The batch size exceeds the allowed maximum',
    category: 'validation',
  },
  UNAUTHORIZED: {
    code: 'unauthorized',
    sdkClassName: 'UnauthorizedCredenceError',
    kind: 'api',
    httpStatus: 401,
    defaultMessage: 'Authentication is required',
    category: 'authentication',
  },
  FORBIDDEN: {
    code: 'forbidden',
    sdkClassName: 'ForbiddenCredenceError',
    kind: 'api',
    httpStatus: 403,
    defaultMessage: 'The authenticated caller is not allowed to perform this action',
    category: 'authorization',
  },
  NOT_FOUND: {
    code: 'not_found',
    sdkClassName: 'NotFoundCredenceError',
    kind: 'api',
    httpStatus: 404,
    defaultMessage: 'The requested resource was not found',
    category: 'resource',
  },
  CONFLICT: {
    code: 'conflict',
    sdkClassName: 'ConflictCredenceError',
    kind: 'api',
    httpStatus: 409,
    defaultMessage: 'The request conflicts with the current resource state',
    category: 'resource',
  },
  IDEMPOTENCY_KEY_MISMATCH: {
    code: 'idempotency_key_mismatch',
    sdkClassName: 'IdempotencyKeyMismatchCredenceError',
    kind: 'api',
    httpStatus: 409,
    defaultMessage: 'Idempotency key is already bound to a different actor or payload',
    category: 'business',
  },
  INSUFFICIENT_CREDITS: {
    code: 'insufficient_credits',
    sdkClassName: 'InsufficientCreditsCredenceError',
    kind: 'api',
    httpStatus: 402,
    defaultMessage: 'Monthly credit budget exhausted',
    category: 'business',
  },
  INSUFFICIENT_FUNDS: {
    code: 'insufficient_funds',
    sdkClassName: 'InsufficientFundsCredenceError',
    kind: 'api',
    httpStatus: 422,
    defaultMessage: 'The account has insufficient funds for this operation',
    category: 'business',
  },
  INVALID_DISPUTE_TRANSITION: {
    code: 'invalid_dispute_transition',
    sdkClassName: 'InvalidDisputeTransitionCredenceError',
    kind: 'api',
    httpStatus: 422,
    defaultMessage: 'Invalid dispute state transition',
    category: 'business',
  },
  RATE_LIMIT_EXCEEDED: {
    code: 'rate_limit_exceeded',
    sdkClassName: 'RateLimitExceededCredenceError',
    kind: 'api',
    httpStatus: 429,
    defaultMessage: 'Rate limit exceeded',
    category: 'rate_limit',
  },
  INTERNAL_SERVER_ERROR: {
    code: 'internal_server_error',
    sdkClassName: 'InternalServerErrorCredenceError',
    kind: 'api',
    httpStatus: 500,
    defaultMessage: 'An unexpected internal server error occurred',
    category: 'system',
  },
  SERVICE_UNAVAILABLE: {
    code: 'service_unavailable',
    sdkClassName: 'ServiceUnavailableCredenceError',
    kind: 'api',
    httpStatus: 503,
    defaultMessage: 'Service temporarily unavailable',
    category: 'system',
  },
  invalid_input: {
    code: 'invalid_input',
    sdkClassName: 'InvalidInputCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'Invalid input',
    deprecated: true,
    replacedBy: 'validation_failed',
  },
  sdk_request_timeout: {
    code: 'sdk_request_timeout',
    sdkClassName: 'SdkRequestTimeoutCredenceError',
    kind: 'transport',
    httpStatus: 0,
    defaultMessage: 'Request timed out',
  },
  sdk_network_error: {
    code: 'sdk_network_error',
    sdkClassName: 'SdkNetworkErrorCredenceError',
    kind: 'transport',
    httpStatus: 0,
    defaultMessage: 'Network error',
  },
  sdk_invalid_json: {
    code: 'sdk_invalid_json',
    sdkClassName: 'SdkInvalidJsonCredenceError',
    kind: 'transport',
    httpStatus: null,
    defaultMessage: 'Invalid JSON response',
  },
  sdk_unmapped_http: {
    code: 'sdk_unmapped_http',
    sdkClassName: 'SdkUnmappedHttpCredenceError',
    kind: 'transport',
    httpStatus: null,
    defaultMessage: 'Unmapped HTTP error response',
    unmappedHttpFallback: true,
  },
} as const)

export type ErrorCatalogKey = keyof typeof ERROR_CATALOG

export const ERROR_CATALOG_CODES = Object.keys(ERROR_CATALOG) as ErrorCatalogKey[]

export const API_ERROR_CATALOG_CODES = ERROR_CATALOG_CODES.filter(
  (key) => ERROR_CATALOG[key].kind === 'api',
).map((key) => ERROR_CATALOG[key].code)

export const TRANSPORT_ERROR_CATALOG_CODES = ERROR_CATALOG_CODES.filter(
  (key) => ERROR_CATALOG[key].kind === 'transport',
).map((key) => ERROR_CATALOG[key].code)

export function getCatalogEntry(code: string): ErrorCatalogEntry | undefined {
  return ERROR_CATALOG_BY_CODE[code as any]
}

export function getUnmappedHttpFallbackEntry(): ErrorCatalogEntry {
  const entry = ERROR_CATALOG_CODES
    .map((key) => ERROR_CATALOG[key])
    .find((item) => item.unmappedHttpFallback)
  if (!entry) {
    throw new Error('ERROR_CATALOG is missing an unmappedHttpFallback transport entry')
  }
  return entry
}

export const ErrorCode = Object.freeze(
  Object.fromEntries(
    Object.entries(ERROR_CATALOG).map(([key, entry]) => [key, entry.code])
  ) as { readonly [K in ErrorCatalogKey]: (typeof ERROR_CATALOG)[K]['code'] }
)

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const ERROR_CATALOG_BY_CODE = Object.freeze(
  Object.fromEntries(
    Object.values(ERROR_CATALOG).map((entry) => [entry.code, entry])
  ) as Record<ErrorCode, ErrorCatalogEntry>
) as Readonly<Record<ErrorCode, ErrorCatalogEntry>>

const ACTIVE_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(ERROR_CATALOG_BY_CODE))

/**
 * Deprecated code registry. Keep removed/renamed codes here so contract tests
 * can distinguish intentional deprecations from breaking changes.
 */
export const ERROR_CODE_DEPRECATIONS = Object.freeze({}) as Readonly<
  Record<string, ErrorCodeDeprecation>
>

export const DEFAULT_ERROR_LOCALE = 'en' as const

export const ERROR_LOCALIZATION_CATALOG = Object.freeze({
  [DEFAULT_ERROR_LOCALE]: Object.freeze(
    Object.fromEntries(
      Object.values(ERROR_CATALOG).map((entry) => [entry.code, entry.defaultMessage])
    ) as Record<ErrorCode, string>
  ),
}) as Readonly<Record<typeof DEFAULT_ERROR_LOCALE, Readonly<Record<ErrorCode, string>>>>

export type ErrorLocale = keyof typeof ERROR_LOCALIZATION_CATALOG

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && ACTIVE_ERROR_CODES.has(code)
}

export function getErrorCatalogEntry(code: ErrorCode): ErrorCatalogEntry {
  return ERROR_CATALOG_BY_CODE[code]
}

export function getErrorCatalogEntryByCode(code: unknown): ErrorCatalogEntry | undefined {
  return isErrorCode(code) ? ERROR_CATALOG_BY_CODE[code] : undefined
}

export function getLocalizedErrorMessage(
  code: ErrorCode,
  locale: ErrorLocale = DEFAULT_ERROR_LOCALE
): string {
  return ERROR_LOCALIZATION_CATALOG[locale]?.[code]
    ?? ERROR_LOCALIZATION_CATALOG[DEFAULT_ERROR_LOCALE][code]
}
