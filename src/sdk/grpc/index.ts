/**
 * src/sdk/grpc/index.ts
 *
 * Public barrel export for the Credence internal gRPC SDK.
 *
 * Import from this path rather than from individual files:
 *
 *   import {
 *     createCredenceGrpcClient,
 *     type CredenceGrpcClient,
 *     type CredenceGrpcConfig,
 *     INTERNAL_TOKEN_HEADER,
 *   } from './src/sdk/grpc/index.js'
 */

export {
  createCredenceGrpcClient,
  type CredenceGrpcClient,
  type CredenceGrpcConfig,
} from './client.js'

export {
  createSharedSecretInterceptor,
  createRequestIdInterceptor,
  createDeadlineInterceptor,
  GRPC_DEADLINE_REMAINING_KEY,
  GRPC_DEFAULT_TIMEOUT_MS,
  isDeadlineExceededError,
  INTERNAL_TOKEN_HEADER,
} from './interceptors.js'

// Generated message types and enums
export * from './types.js'
