// REST/HTTP client
export { CredenceClient } from './client.js'
export {
  CredenceConfig,
  CredenceApiError,
  TrustScore,
  BondStatus,
  Attestation,
  AttestationsResponse,
  VerificationProof,
} from './types.js'

// Internal gRPC client (Connect-RPC) — OPTIONAL / OFF BY DEFAULT.
//
// The gRPC wrappers under ./grpc live in a separate build target
// (tsconfig.grpc.json) because they depend on generated protobuf stubs and
// runtime packages that are not installed by default:
//   npm install @bufbuild/protobuf @connectrpc/connect @connectrpc/connect-node
//   buf generate   (populates src/sdk/grpc/gen/)
//
// Re-exporting them from this barrel would pull the (currently uninstalled)
// dependencies and the not-yet-generated stubs into the main TypeScript
// program. Keep this export commented out until the gRPC toolchain is wired
// up; consumers that need it should import from './grpc/index.js' directly
// within a project configured via tsconfig.grpc.json.
//
// export {
//   createCredenceGrpcClient,
//   type CredenceGrpcClient,
//   type CredenceGrpcConfig,
//   createSharedSecretInterceptor,
//   createRequestIdInterceptor,
//   INTERNAL_TOKEN_HEADER,
// } from './grpc/index.js'
