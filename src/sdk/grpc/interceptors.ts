/**
 * src/sdk/grpc/interceptors.ts
 *
 * Connect-RPC interceptors shared by all internal gRPC clients.
 *
 * The shared-secret interceptor injects the `x-credence-internal-token`
 * header on every outbound request.  The gRPC server validates this header
 * before processing any call.
 *
 * Usage:
 *   import { createSharedSecretInterceptor } from './interceptors.js'
 *   const transport = createGrpcWebTransport({
 *     baseUrl,
 *     interceptors: [createSharedSecretInterceptor(secret)],
 *   })
 */

// NOTE: The actual @connectrpc/connect import is resolved at runtime once
// `buf generate` has been run and the npm packages are installed.
// The type import below uses a conditional so that this file compiles even
// before code generation has been executed.
import type { Interceptor } from '@connectrpc/connect'
import { tracingContext } from '../../utils/logger.js'

/**
 * INTERNAL_TOKEN_HEADER is the metadata key used to authenticate internal
 * service-to-service gRPC calls.  The server rejects requests that omit or
 * present an invalid value for this header.
 */
export const INTERNAL_TOKEN_HEADER = 'x-credence-internal-token'

/**
 * createSharedSecretInterceptor returns a Connect-RPC interceptor that
 * attaches the shared secret to every outbound request header.
 *
 * @param secret - The shared secret configured via GRPC_INTERNAL_SECRET.
 *                 Must be non-empty.
 */
export function createSharedSecretInterceptor(secret: string): Interceptor {
  if (!secret) {
    throw new Error(
      'createSharedSecretInterceptor: secret must be non-empty. ' +
        'Set the GRPC_INTERNAL_SECRET environment variable.',
    )
  }

  return (next) => (req) => {
    req.header.set(INTERNAL_TOKEN_HEADER, secret)
    return next(req)
  }
}

/**
 * createRequestIdInterceptor returns an interceptor that propagates the
 * X-Request-ID header from the current async context into outbound gRPC
 * calls, enabling end-to-end distributed tracing.
 *
 * Pass the requestId string obtained from the Express requestIdMiddleware.
 * If not provided, it falls back to the tracingContext store.
 */
export function createRequestIdInterceptor(requestId?: string): Interceptor {
  return (next) => (req) => {
    const id = requestId || tracingContext.getStore()?.get('requestId')
    if (id) {
      req.header.set('x-request-id', id)
    }
    return next(req)
  }
}
