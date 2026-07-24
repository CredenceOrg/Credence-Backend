/**
 * Request body-size limit middleware.
 *
 * Caps JSON request bodies at 1 MiB and translates the body parser's generic
 * 413 "entity.too.large" failure into the typed REQUEST_TOO_LARGE AppError so
 * clients receive a stable, machine-readable error code.
 *
 * Threat mitigated: without an explicit body-size cap, an unauthenticated
 * client can post arbitrarily large payloads, forcing the server to buffer and
 * parse them — a cheap memory-exhaustion / denial-of-service vector. Capping
 * the body and failing closed with a typed error removes that vector.
 */
import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import { RequestTooLargeError } from '../lib/errors.js'

/** Maximum accepted request body size, in bytes (1 MiB). */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024

/** Limit string understood by body-parser / express.json. */
export const MAX_REQUEST_BODY_LIMIT = '1mb'

/** JSON body parser capped at {@link MAX_REQUEST_BODY_BYTES}. */
export const jsonBodyParser: RequestHandler = express.json({
  limit: MAX_REQUEST_BODY_LIMIT,
})

/** Narrows an unknown error to body-parser's payload-too-large failure. */
function isPayloadTooLargeError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false
  }
  const candidate = err as { type?: unknown; status?: unknown; statusCode?: unknown }
  return (
    candidate.type === 'entity.too.large' ||
    candidate.status === 413 ||
    candidate.statusCode === 413
  )
}

/**
 * Express error-handling middleware that converts body-parser's oversized-body
 * error into a typed {@link RequestTooLargeError}. All other errors pass through
 * unchanged to the next error handler.
 */
export const requestSizeLimitErrorHandler: ErrorRequestHandler = (err, _req, _res, next) => {
  if (isPayloadTooLargeError(err)) {
    next(new RequestTooLargeError(`Request body exceeds the ${MAX_REQUEST_BODY_LIMIT} limit`))
    return
  }
  next(err)
}
