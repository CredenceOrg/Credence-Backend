/**
 * src/sdk/grpc/client.ts
 *
 * CredenceGrpcClient — typed factory for all internal gRPC service clients.
 *
 * This module wraps the Connect-RPC generated stubs with a single
 * configuration point so that callers don't need to manage transports,
 * interceptors, or service descriptors directly.
 *
 * Prerequisites (run once):
 *   npm install @bufbuild/protobuf @connectrpc/connect @connectrpc/connect-node
 *   buf generate   # populates src/sdk/grpc/gen/
 *
 * Usage:
 *   import { createCredenceGrpcClient } from './src/sdk/grpc/client.js'
 *
 *   const grpc = createCredenceGrpcClient({
 *     baseUrl: process.env.GRPC_BASE_URL!,
 *     sharedSecret: process.env.GRPC_INTERNAL_SECRET!,
 *   })
 *
 *   const { trustScore } = await grpc.trust.getTrustScore({ address })
 */

import { createGrpcTransport } from '@connectrpc/connect-node'
import { createClient } from '@connectrpc/connect'

import { createSharedSecretInterceptor } from './interceptors.js'

// Generated service descriptors — populated by `buf generate`.
// If these imports fail, run `buf generate` first.
import { TrustService }        from './gen/credence/v1/trust_connect.js'
import { BondService }         from './gen/credence/v1/bond_connect.js'
import { AttestationService }  from './gen/credence/v1/attestation_connect.js'
import { VerificationService } from './gen/credence/v1/verification_connect.js'
import { GovernanceService }   from './gen/credence/v1/governance_connect.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CredenceGrpcConfig {
  /**
   * Base URL of the internal gRPC server, e.g. "http://credence-internal:50051".
   * Must include the scheme and port.  No trailing slash.
   */
  baseUrl: string

  /**
   * Shared secret injected as `x-credence-internal-token` on every request.
   * Corresponds to the GRPC_INTERNAL_SECRET environment variable.
   */
  sharedSecret: string

  /**
   * Optional request timeout in milliseconds.  Defaults to 10 000 ms.
   */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Client shape
// ---------------------------------------------------------------------------

/**
 * CredenceGrpcClient groups all internal service clients under a single
 * namespace so callers can do:
 *
 *   grpc.trust.getTrustScore(...)
 *   grpc.bond.getBond(...)
 *   grpc.attestation.listAttestations(...)
 *   grpc.verification.getVerificationProof(...)
 *   grpc.governance.submitDispute(...)
 */
export interface CredenceGrpcClient {
  trust:        ReturnType<typeof createClient<typeof TrustService>>
  bond:         ReturnType<typeof createClient<typeof BondService>>
  attestation:  ReturnType<typeof createClient<typeof AttestationService>>
  verification: ReturnType<typeof createClient<typeof VerificationService>>
  governance:   ReturnType<typeof createClient<typeof GovernanceService>>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * createCredenceGrpcClient builds a fully configured CredenceGrpcClient.
 *
 * The returned object is cheap to create and safe to share across requests.
 * Instantiate once at application startup and inject via dependency injection.
 *
 * @throws {Error} when baseUrl or sharedSecret is empty.
 */
export function createCredenceGrpcClient(config: CredenceGrpcConfig): CredenceGrpcClient {
  const { baseUrl, sharedSecret, timeoutMs = 10_000 } = config

  if (!baseUrl) {
    throw new Error('createCredenceGrpcClient: baseUrl is required')
  }

  const transport = createGrpcTransport({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    httpVersion: '2',
    interceptors: [
      createSharedSecretInterceptor(sharedSecret),
    ],
    // Apply a default deadline to every call.  Individual callers can
    // override this by passing a signal or deadline to the RPC method.
    defaultTimeoutMs: timeoutMs,
  })

  return {
    trust:        createClient(TrustService,        transport),
    bond:         createClient(BondService,         transport),
    attestation:  createClient(AttestationService,  transport),
    verification: createClient(VerificationService, transport),
    governance:   createClient(GovernanceService,   transport),
  }
}
