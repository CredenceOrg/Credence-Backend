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
  INTERNAL_TOKEN_HEADER,
} from './interceptors.js'

// Generated message types and enums
export * from './types.js'
