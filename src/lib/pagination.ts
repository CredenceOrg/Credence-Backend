export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

export interface PaginationParams {
  page: number
  limit: number
  offset: number
}

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  hasNext: boolean
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
  if (value === undefined) {
    return undefined
  }

  if (typeof value === 'string' && value.trim() === '') {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
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

  const rawOffset = query.offset ?? query.cursor
  const offsetPath = query.offset !== undefined ? 'offset' : 'cursor'
  try {
    offset = parsePositiveInteger(rawOffset, offsetPath)
  } catch (error) {
    if (error instanceof PaginationValidationError) {
      errors.push(...error.details)
    } else {
      throw error
    }
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

export function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: timestamp, i: id }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<DecodedCursor>
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') {
      return null
    }
    return { t: parsed.t, i: parsed.i }
  } catch {
    return null
  }
}
