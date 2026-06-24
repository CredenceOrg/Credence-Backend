# src/sdk/grpc/

This directory contains the hand-written gRPC client wrappers that internal
services use to call Credence over Connect-RPC (gRPC-compatible).

## Directory layout

```
src/sdk/grpc/
├── gen/                  ← buf generate output (committed, do not edit by hand)
│   ├── credence/v1/
│   │   ├── trust_pb.ts
│   │   ├── trust_connect.ts
│   │   ├── bond_pb.ts
│   │   ├── bond_connect.ts
│   │   ├── attestation_pb.ts
│   │   ├── attestation_connect.ts
│   │   ├── verification_pb.ts
│   │   ├── verification_connect.ts
│   │   ├── governance_pb.ts
│   │   ├── governance_connect.ts
│   │   └── common_pb.ts
├── client.ts             ← CredenceGrpcClient factory (this file)
├── interceptors.ts       ← shared-secret auth interceptor
├── types.ts              ← re-exported generated types
└── index.ts              ← public barrel export
```

## Regenerating stubs

```bash
# Install buf (one-time):
npm install --save-dev @bufbuild/buf @bufbuild/protoc-gen-es @connectrpc/protoc-gen-connect-es

# Regenerate:
buf generate
```

## Usage

```typescript
import { createCredenceGrpcClient } from './src/sdk/grpc/index.js'

const client = createCredenceGrpcClient({
  baseUrl: 'http://credence-internal:50051',
  sharedSecret: process.env.GRPC_INTERNAL_SECRET!,
})

const { trustScore } = await client.trust.getTrustScore({ address: '0xabc' })
console.log(trustScore?.score)
```
