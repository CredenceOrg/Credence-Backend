# Credence Internal gRPC API

This document describes the gRPC service contracts used for internal
service-to-service communication within the Credence platform.

---

## Overview

Credence exposes a set of gRPC services alongside its public REST API.
These services are **internal only** — they are not reachable from the
public internet and require a shared secret for authentication.

| Transport | Protocol | Auth |
|-----------|----------|------|
| HTTP/2 | Connect-RPC (gRPC-compatible) | `x-credence-internal-token` header |

The proto definitions live in `proto/credence/v1/` and are managed with
[Buf](https://buf.build).

---

## Services

| Service | Proto file | Description |
|---------|-----------|-------------|
| `TrustService` | `trust.proto` | Query trust scores for one or many addresses |
| `BondService` | `bond.proto` | Query bond status and lifecycle state |
| `AttestationService` | `attestation.proto` | List and create attestations |
| `VerificationService` | `verification.proto` | Generate and verify cryptographic proofs |
| `GovernanceService` | `governance.proto` | Disputes and slash-request voting |

---

## Authentication

Every gRPC call must include the shared secret in the request metadata:

```
x-credence-internal-token: <GRPC_INTERNAL_SECRET>
```

The server rejects calls that omit or present an invalid token with
`UNAUTHENTICATED`.

The TypeScript SDK handles this automatically via the
`createSharedSecretInterceptor` — see [SDK Usage](#sdk-usage) below.

---

## Proto layout

```
proto/
└── credence/
    └── v1/
        ├── common.proto        ← shared types, pagination, privacy options
        ├── trust.proto         ← TrustService
        ├── bond.proto          ← BondService
        ├── attestation.proto   ← AttestationService
        ├── verification.proto  ← VerificationService
        └── governance.proto    ← GovernanceService
```

---

## Field numbering rules

Field numbers are **permanent**.  Once a field is assigned a number it must
never be reused, even after the field is removed.  Use `reserved` statements
to document retired numbers:

```protobuf
message Example {
  string name = 1;
  // Field 2 was `legacy_field` — removed in v1.2.0.
  reserved 2;
  reserved "legacy_field";
  string description = 3;
}
```

---

## Breaking-change policy

The `buf breaking` CI step (`.github/workflows/buf.yml`) enforces the
following rules on every pull request targeting `main`:

| Rule category | What is checked |
|---------------|----------------|
| `FILE` | Proto files must not be deleted |
| `PACKAGE` | Package names must not change |
| `FIELD_NO_DELETE` | Fields must not be removed |
| `FIELD_SAME_NUMBER` | Field numbers must not change |
| `FIELD_SAME_TYPE` | Field types must not change |
| `ENUM_VALUE_NO_DELETE` | Enum values must not be removed |
| `SERVICE_NO_DELETE` | Services must not be removed |
| `RPC_NO_DELETE` | RPCs must not be removed |

### Allowed changes (non-breaking)

- Adding new fields (with new field numbers)
- Adding new enum values (at the end)
- Adding new RPCs to an existing service
- Adding new services
- Adding new proto files
- Changing comments or documentation

### Forbidden changes (breaking)

- Removing or renumbering fields
- Changing a field's type
- Renaming the package
- Removing services, RPCs, or enum values
- Reusing a previously deleted field number

---

## Edge cases

### Field number reuse

**Never reuse a field number**, even if the original field was removed.
Reusing a number causes silent data corruption when old and new clients
communicate because the wire encoding is keyed by number, not name.

```protobuf
// WRONG — do not do this:
message Bad {
  // string old_field = 1;  ← removed
  int32 new_field = 1;      ← reuses field 1 — FORBIDDEN
}

// CORRECT:
message Good {
  reserved 1;
  reserved "old_field";
  int32 new_field = 2;      ← new number
}
```

### Reserved fields

When removing a field, always add both a `reserved` number and a
`reserved` name statement to prevent accidental reuse:

```protobuf
message TrustScore {
  reserved 7;
  reserved "deprecated_field";
  // ... remaining fields
}
```

### Package renames

Renaming the package (e.g. `credence.v1` → `credence.v2`) is a breaking
change that requires a new major version directory (`proto/credence/v2/`).
The old package must remain published until all consumers have migrated.

---

## PII / Privacy classification

Any proto field that carries personally-identifiable information (PII) must
be annotated with the `SENSITIVE` privacy classification defined in
`common.proto`.

```protobuf
import "credence/v1/common.proto";

message UserRecord {
  // Public blockchain address — no PII.
  string address = 1;

  // Email address — PII, must be classified SENSITIVE.
  string email = 2 [(credence.v1.privacy).classification = SENSITIVE];

  // Free-form note that may contain PII.
  string note = 3 [(credence.v1.privacy).classification = SENSITIVE];
}
```

Fields classified `SENSITIVE` must be:
- Encrypted at rest in the database
- Redacted in application logs
- Excluded from analytics aggregations unless explicitly anonymised

The `buf lint` step will flag any field whose name matches the PII pattern
list (e.g. `email`, `phone`, `ssn`, `dob`) that lacks a privacy annotation.

---

## SDK Usage

### Installation

```bash
# Runtime dependencies
npm install @bufbuild/protobuf @connectrpc/connect @connectrpc/connect-node

# Dev dependencies (code generation)
npm install --save-dev @bufbuild/buf @bufbuild/protoc-gen-es @connectrpc/protoc-gen-connect-es
```

### Generate TypeScript stubs

```bash
buf generate
# Output: src/sdk/grpc/gen/
```

### Create a client

```typescript
import { createCredenceGrpcClient } from './src/sdk/grpc/index.js'

const grpc = createCredenceGrpcClient({
  baseUrl: process.env.GRPC_BASE_URL!,       // e.g. "http://credence-internal:50051"
  sharedSecret: process.env.GRPC_INTERNAL_SECRET!,
  timeoutMs: 5_000,                           // optional, default 10 000
})
```

### Query a trust score

```typescript
const { trustScore } = await grpc.trust.getTrustScore({
  address: '0xabc123...',
})

console.log(trustScore?.score)          // 0-100
console.log(trustScore?.bondedAmount)   // "1000.0000000"
```

### Batch trust scores

```typescript
const { trustScores } = await grpc.trust.batchGetTrustScores({
  addresses: ['0xabc...', '0xdef...'],
})
```

### Query bond status

```typescript
import { BondStatus } from './src/sdk/grpc/index.js'

const { bond } = await grpc.bond.getBond({ address: '0xabc...' })

if (bond?.status === BondStatus.BOND_STATUS_ACTIVE) {
  console.log('Bond is active, amount:', bond.bondedAmount)
}
```

### List attestations

```typescript
const { attestations, page } = await grpc.attestation.listAttestations({
  subjectAddress: '0xabc...',
  page: { pageSize: 20, pageToken: '' },
})
```

### Submit a dispute

```typescript
const { dispute } = await grpc.governance.submitDispute({
  filedBy: '0xabc...',
  respondent: '0xdef...',
  evidence: ['ipfs://Qm...'],
})
```

### Error handling

Connect-RPC throws `ConnectError` on non-OK status codes:

```typescript
import { ConnectError, Code } from '@connectrpc/connect'

try {
  const { trustScore } = await grpc.trust.getTrustScore({ address })
} catch (err) {
  if (err instanceof ConnectError) {
    if (err.code === Code.NotFound) {
      console.log('Address has no identity record')
    } else {
      console.error('gRPC error:', err.code, err.message)
    }
  }
}
```

---

## Running buf locally

```bash
# Install buf (macOS/Linux)
brew install bufbuild/buf/buf

# Or via npm
npm install --save-dev @bufbuild/buf

# Lint all proto files
buf lint

# Check for breaking changes against main
buf breaking --against '.git#branch=main'

# Generate TypeScript stubs
buf generate
```

---

## CI workflow

The `.github/workflows/buf.yml` workflow runs on every PR targeting `main`
that touches `proto/**`, `buf.yaml`, or `buf.gen.yaml`.

| Job | Trigger | What it does |
|-----|---------|-------------|
| `buf-lint` | push + PR | Runs `buf lint` against all proto files |
| `buf-breaking` | PR only | Runs `buf breaking --against '.git#branch=origin/main'` |
| `buf-generate` | push + PR | Runs `buf generate` then `tsc --noEmit` on generated stubs |

The `buf-breaking` job fails the PR if any wire-breaking change is detected,
preventing accidental contract violations from reaching `main`.
