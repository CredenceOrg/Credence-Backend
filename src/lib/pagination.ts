import { createHmac } from 'crypto'
import { loadConfig } from '../config/index.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

export interface PaginationParams {
  page: number
  limit: number
  offset: number
  cursor: string | null
  decodedCursor?: DecodedCursor
}

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  hasNext: boolean
}

export interface CursorPaginationMeta {
  limit: number
  hasNextPage: boolean
  nextCursor?: string
}

/**
 * Standard cursor-based pagination envelope.
 * Provides a consistent response structure for paginated endpoints.
 */
export interface CursorPaginationEnvelope<T> {
  data: T[]
  page: {
    nextCursor: string | null
    hasMore: boolean
    limit: number
  }
}

/**
 * Options for building a cursor pagination envelope.
 */
export interface BuildCursorEnvelopeOptions {
  limit: number
  hasMore: boolean
  nextCursor?: string | null
}

export interface DecodedCursor {
  t: string
  i: string
}

export interface PaginationParseOptions {
  defaultPage?: number
  defaultLimit?: number
  maxLimit?: number
}

export class PaginationValidationError extends Error {
  readonly details: Array<{ path: string; message: string }>

  constructor(details: Array<{ path: string; message: string }>) {
    super('Invalid pagination parameters')
    this.name = 'PaginationValidationError'
    this.details = details
  }
}

function parsePositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value === 'string' && value.trim() === '') {
    return undefined
  }

  const parsed = Number(value)
  if (Number.isNaN(parsed) || !Number.isInteger(parsed)) {
    throw new PaginationValidationError([{ path, message: 'Expected an integer' }])
  }

  return parsed
}

export function parsePaginationParams(
  query: Record<string, unknown>,
  options: PaginationParseOptions = {},
): PaginationParams {
  const defaultPage = options.defaultPage ?? DEFAULT_PAGE
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT
  const maxLimit = options.maxLimit ?? MAX_LIMIT

  const errors: Array<{ path: string; message: string }> = []

  let page: number | undefined
  let limit: number | undefined
  let offset: number | undefined

  try {
    page = parsePositiveInteger(query.page, 'page')
  } catch (error) {
    if (error instanceof PaginationValidationError) {
      errors.push(...error.details)
    } else {
      throw error
    }
  }

  try {
    limit = parsePositiveInteger(query.limit, 'limit')
  } catch (error) {
    if (error instanceof PaginationValidationError) {
      errors.push(...error.details)
    } else {
      throw error
    }
  }

  // Treat an empty (or whitespace-only) cursor query param as "no cursor"
  // rather than an invalid one, so `?cursor=` is ignored gracefully.
  const rawCursor =
    typeof query.cursor === 'string' && query.cursor.trim() !== ''
      ? query.cursor
      : null

  let decodedCursor: DecodedCursor | undefined
  if (rawCursor) {
    try {
      decodedCursor = decodeCursor(rawCursor) ?? undefined
    } catch (error) {
      if (error instanceof PaginationValidationError) {
        errors.push(...error.details)
      } else {
        throw error
      }
    }
  }

  // Backwards compatibility: allow client to pass offset via ?cursor=10
  // But ONLY if it parses as an integer and is NOT a valid encoded cursor
  let rawOffset = query.offset
  if (rawOffset === undefined && rawCursor !== null && !decodedCursor) {
    rawOffset = rawCursor
  }
  
  const offsetPath = query.offset !== undefined ? 'offset' : 'cursor'
  try {
    // Only attempt to parse offset if it's explicitly provided or cursor is used as a legacy offset
    if (rawOffset !== undefined) {
      offset = parsePositiveInteger(rawOffset, offsetPath)
    }
  } catch (error) {
    // If it fails, only add error if it was strictly meant to be an offset,
    // or if we failed fallback parsing. But to be safe, if decodedCursor is valid,
    // we should just ignore the offset parsing error.
    if (!decodedCursor) {
      if (error instanceof PaginationValidationError) {
        errors.push(...error.details)
      } else {
        throw error
      }
    }
  }

  // Reject tampered/invalid cursor strings that aren't numeric offsets either
  if (rawCursor !== null && !decodedCursor && offset === undefined) {
    errors.push({ path: 'cursor', message: 'Invalid cursor format' })
  }

  if (page !== undefined && page < 1) {
    errors.push({ path: 'page', message: 'Page must be at least 1' })
  }
  if (limit !== undefined && limit < 1) {
    errors.push({ path: 'limit', message: 'Limit must be at least 1' })
  }
  if (limit !== undefined && limit > maxLimit) {
    errors.push({ path: 'limit', message: `Limit must be at most ${maxLimit}` })
  }
  if (offset !== undefined && offset < 0) {
    errors.push({ path: offsetPath, message: `${offsetPath} must be at least 0` })
  }

  if (errors.length > 0) {
    throw new PaginationValidationError(errors)
  }

  const resolvedLimit = limit ?? defaultLimit
  const resolvedPage =
    page ?? (offset !== undefined ? Math.floor(offset / resolvedLimit) + 1 : defaultPage)
  const resolvedOffset = offset ?? (resolvedPage - 1) * resolvedLimit

  return {
    page: resolvedPage,
    limit: resolvedLimit,
    offset: resolvedOffset,
    cursor: rawCursor,
    decodedCursor: decodedCursor ?? undefined,
  }
}

export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number,
): PaginationMeta {
  return {
    page,
    limit,
    total,
    hasNext: page * limit < total,
  }
}

export function buildCursorPaginationMeta(
  hasNextPage: boolean,
  limit: number,
  nextCursor?: string,
): CursorPaginationMeta {
  return {
    limit,
    hasNextPage,
    nextCursor,
  }
}

export function encodeCursor(timestamp: string | Date, id: string): string {
  const t = timestamp instanceof Date ? timestamp.toISOString() : timestamp
  const payload = JSON.stringify({ t, i: id })
  const secret = loadConfig().jwt.secret
  const h = createHmac('sha256', secret).update(payload).digest('hex')
  return Buffer.from(JSON.stringify({ t, i: id, h }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<DecodedCursor & { h: string }>
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') {
      return null
    }

    if (typeof parsed.h !== 'string') {
      throw new PaginationValidationError([{ path: 'cursor', message: 'Cursor signature missing' }])
    }

    const payload = JSON.stringify({ t: parsed.t, i: parsed.i })
    const secret = loadConfig().jwt.secret
    const expected = createHmac('sha256', secret).update(payload).digest('hex')
    if (parsed.h !== expected) {
      throw new PaginationValidationError([{ path: 'cursor', message: 'Cursor has been tampered with' }])
    }

    return { t: parsed.t, i: parsed.i }
  } catch (error) {
    if (error instanceof PaginationValidationError) {
      throw error
    }
    return null
  }
}

/**
 * Builds a standard cursor pagination envelope for API responses.
 * @template T The type of items in the data array
 * @param data The paginated results
 * @param options Pagination metadata options
 * @returns A standardized envelope with data and pagination info
 */
export function buildCursorEnvelope<T>(
  data: T[],
  options: BuildCursorEnvelopeOptions
): CursorPaginationEnvelope<T> {
  return {
    data,
    page: {
      nextCursor: options.nextCursor ?? null,
      hasMore: options.hasMore,
      limit: options.limit,
    },
  }
}
