/**
 * Pagination parameters interface.
 */
export interface PaginationParams {
    limit: number;
    offset: number;
}

/**
 * Paginated response structure.
 */
export interface PaginatedResponse<T> {
    data: T[];
    pagination: {
        nextOffset: number | null;
        hasMore: boolean;
        total?: number;
    };
}

/**
 * Extracts and validates pagination parameters from a query object.
 * Handles both offset/limit and limit/cursor scenarios implicitly via offset.
 *
 * @param query - The query object from an Express request
 * @param defaultLimit - Default limit if not provided (default 10)
 * @param maxLimit - Maximum allowed limit (default 100)
 * @returns Parsed and validated pagination parameters
 */
export function getPaginationParams(
    query: any,
    defaultLimit = 10,
    maxLimit = 100
): PaginationParams {
    let limit = defaultLimit;
    let offset = 0;

    if (query.limit !== undefined) {
        const parsedLimit = parseInt(String(query.limit), 10);
        if (!isNaN(parsedLimit) && parsedLimit > 0) {
            limit = Math.min(parsedLimit, maxLimit);
        }
    }

    // Handle both offset and cursor as the same conceptual value for simple APIs
    const queryOffset = query.offset ?? query.cursor;
    if (queryOffset !== undefined) {
        const parsedOffset = parseInt(String(queryOffset), 10);
        if (!isNaN(parsedOffset) && parsedOffset >= 0) {
            offset = parsedOffset;
        }
    }

    return { limit, offset };
}

/**
 * Builds a standardized paginated response.
 *
 * @param data - The array of data items for the current page
 * @param limit - The requested limit
 * @param offset - The requested offset
 * @param total - Optional total number of items
 * @returns A structured paginated response
 */
export function buildPaginatedResponse<T>(
    data: T[],
    limit: number,
    offset: number,
    total?: number
): PaginatedResponse<T> {
    // If we fetched the requested limit, we assume there might be more unless proven otherwise.
    // The most accurate way is for the query to fetch `limit + 1` and slice, or provide `total`.
    // We'll rely on the data length. If data.length === limit, we assume hasMore = true.
    // (A common optimization is to fetch limit + 1 from DB).
    const hasMore = data.length >= limit;
    const nextOffset = hasMore ? offset + data.length : null;

    return {
        data,
        pagination: {
            nextOffset,
            hasMore,
            ...(total !== undefined ? { total } : {}),
        },
    };
}
