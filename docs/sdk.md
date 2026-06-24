# Credence Developer SDK

A TypeScript/JavaScript client for the Credence Backend API. Provides typed methods for querying trust scores, bond status, attestations, and verification proofs.

## Installation

The SDK lives inside this repository at `src/sdk/`. To use it locally:

```typescript
import { CredenceClient } from './src/sdk/index.js'
```

To publish as a standalone package, extract `src/sdk/` into its own npm package and point the import at the package name.

## Quick Start

```typescript
import { CredenceClient } from './src/sdk/index.js'

const client = new CredenceClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'your-api-key', // optional
})

const trust = await client.getTrustScore('0xabc...')
console.log(trust.score)
```

## Configuration

| Option    | Type     | Required | Default | Description                        |
|-----------|----------|----------|---------|------------------------------------|
| `baseUrl` | `string` | Yes      | —       | Base URL of the Credence API       |
| `apiKey`  | `string` | No       | —       | Bearer token sent in Authorization |
| `timeout` | `number` | No       | 30000   | Request timeout in milliseconds    |

## Methods

### `getTrustScore(address: string): Promise<TrustScore>`

Returns the trust score for a given address.

```typescript
const result = await client.getTrustScore('0xabc...')
```

Response type:

```typescript
interface TrustScore {
  address: string
  score: number
  bondedAmount: string
  bondStart: string | null
  attestationCount: number
}
```

### `getBondStatus(address: string): Promise<BondStatus>`

Returns the bond status for a given address.

```typescript
const result = await client.getBondStatus('0xabc...')
```

Response type:

```typescript
interface BondStatus {
  address: string
  bondedAmount: string
  bondStart: string | null
  bondDuration: number | null
  active: boolean
  slashedAmount: string
  status: 'active' | 'slashed' | 'inactive' | 'unbonded'
}
```

### `getAttestations(address: string): Promise<AttestationsResponse>`

Returns attestations for a given address.

```typescript
const result = await client.getAttestations('0xabc...')
console.log(result.attestations) // Attestation[]
```

Response type:

```typescript
interface AttestationsResponse {
  address: string
  attestations: Attestation[]
  count: number
}

interface Attestation {
  id: string
  attester: string
  subject: string
  value: string
  timestamp: string
}
```

### `getVerificationProof(address: string): Promise<VerificationProof>`

Returns the verification proof for a given address.

```typescript
const result = await client.getVerificationProof('0xabc...')
if (result.verified) {
  console.log(result.proof)
}
```

Response type:

```typescript
interface VerificationProof {
  address: string
  proof: string | null
  verified: boolean
  timestamp: string | null
}
```

---

## Error Architecture

The SDK error taxonomy is generated from the backend error-code registry so that API envelopes and SDK classes stay in lockstep.

### Layer overview

```text
src/lib/errors.ts          Backend ErrorCode enum + AppError hierarchy
        │
        ▼
src/lib/errorCatalog.ts    Structured metadata (HTTP status, transport, deprecated, …)
        │
        ▼
scripts/generate-sdk-errors.ts
        │
        ▼
src/sdk/errors.generated.ts   CredenceError base + one typed class per catalog entry
        │
        ▼
src/sdk/client.ts          Parses { error, code, details? } and throws typed errors
```

### Backend API envelope

All backend errors use a consistent JSON shape:

```json
{
  "error": "Human-readable description",
  "code": "not_found",
  "details": { "optional": "context" }
}
```

The `code` field uses snake_case wire values defined in `ErrorCode` (`src/lib/errors.ts`).

### Error catalog (`src/lib/errorCatalog.ts`)

Each catalog entry includes:

| Field | Purpose |
|-------|---------|
| `code` | Wire value returned in API envelopes |
| `sdkClassName` | Generated SDK class name |
| `kind` | `api` (backend envelope) or `transport` (client-side only) |
| `httpStatus` | Default HTTP status for API errors (`null` for detail-only or transport codes) |
| `defaultMessage` | Fallback message when constructing SDK errors |
| `deprecated` | When `true`, generated class is marked `@deprecated` |
| `replacedBy` | Replacement wire code for deprecated entries |
| `unmappedHttpFallback` | Marks the transport fallback for non-envelope HTTP bodies |

Transport-only codes (not emitted by the backend):

| Code | Class | When thrown |
|------|-------|-------------|
| `sdk_request_timeout` | `SdkRequestTimeoutCredenceError` | AbortController timeout |
| `sdk_network_error` | `SdkNetworkErrorCredenceError` | Fetch/network failure |
| `sdk_invalid_json` | `SdkInvalidJsonCredenceError` | Success response with non-JSON body |
| `sdk_unmapped_http` | `SdkUnmappedHttpCredenceError` | HTTP error without `{ error, code }` envelope |

Deprecated API codes remain in the catalog for backward-compatible client mapping. Example: `invalid_input` maps to `InvalidInputCredenceError` and is replaced by `validation_failed`.

### Generated SDK errors (`src/sdk/errors.generated.ts`)

**Do not edit this file by hand.** Regenerate it whenever the catalog changes:

```bash
npm run generate:sdk-errors
```

Generated artifacts include:

- `CredenceError` — base class with `code`, `status`, `details`, optional `rawBody`
- One subclass per catalog entry (e.g. `NotFoundCredenceError`)
- `CREDENCE_ERROR_REGISTRY` — maps wire codes to constructors
- `createCredenceErrorFromEnvelope()` — maps API JSON to typed errors
- `createTransportCredenceError()` — factory for transport errors
- `parseCredenceErrorEnvelope()` — validates and parses error JSON bodies
- `sanitizeCauseChain()` — strips stack traces from nested `cause` chains

#### Stack trace safety

When transport failures attach a native `Error` as `cause`, the SDK sanitizes the chain before serialization. Only `name`, `message`, and nested `cause` metadata are preserved — **stack traces are never exposed** through `CredenceError.toJSON()` or the `cause` property.

```typescript
import { sanitizeCauseChain } from './src/sdk/index.js'

const sanitized = sanitizeCauseChain(new Error('fetch failed'))
// { name: 'Error', message: 'fetch failed' } — no stack property
```

### Client error mapping (`src/sdk/client.ts`)

| Scenario | Thrown class | `code` | Typical `status` |
|----------|--------------|--------|------------------|
| Structured API error | Typed subclass (e.g. `NotFoundCredenceError`) | Backend wire code | HTTP status from response |
| Unknown API `code` in envelope | `SdkUnmappedHttpCredenceError` | `sdk_unmapped_http` | HTTP status from response |
| Unstructured HTTP error body | `SdkUnmappedHttpCredenceError` | `sdk_unmapped_http` | HTTP status from response |
| Invalid JSON on 2xx | `SdkInvalidJsonCredenceError` | `sdk_invalid_json` | HTTP status from response |
| Network failure | `SdkNetworkErrorCredenceError` | `sdk_network_error` | `0` |
| Request timeout | `SdkRequestTimeoutCredenceError` | `sdk_request_timeout` | `0` |

### Handling errors in application code

```typescript
import {
  CredenceClient,
  CredenceError,
  NotFoundCredenceError,
  RateLimitExceededCredenceError,
  SdkNetworkErrorCredenceError,
  isCredenceError,
} from './src/sdk/index.js'

const client = new CredenceClient({ baseUrl: 'http://localhost:3000' })

try {
  await client.getTrustScore('0xabc')
} catch (err) {
  if (err instanceof NotFoundCredenceError) {
    console.error('Identity missing:', err.details)
  } else if (err instanceof RateLimitExceededCredenceError) {
    console.error('Retry after:', err.details)
  } else if (err instanceof SdkNetworkErrorCredenceError) {
    console.error('Transport failure:', err.message)
  } else if (isCredenceError(err)) {
    console.error(err.code, err.status, err.toJSON())
  }
}
```

Use `instanceof` checks against specific generated classes for precise handling, or `isCredenceError()` for generic access to `code`, `status`, and `details`.

### Legacy `CredenceApiError`

`CredenceApiError` in `src/sdk/types.ts` is **deprecated**. It exposed only `status` and a raw `body` string without typed codes. New code should catch `CredenceError` subclasses instead.

---

## Parity Testing

SDK error parity is enforced by `src/__tests__/sdkErrorParity.test.ts`:

- Every catalog entry has a matching generated SDK class
- Every generated registry entry maps back to the catalog
- Wire `code` strings match exactly
- Deprecated entries appear with `@deprecated` in generated output
- Cause-chain sanitization strips stack traces
- Client integration tests in `src/__tests__/sdk.test.ts` verify end-to-end mapping

Run SDK-focused tests:

```bash
npm test -- sdk
```

Coverage thresholds for `src/sdk/**` (excluding generated output) require **95%** statements, branches, functions, and lines.

---

## Regeneration Workflow

1. Add or update entries in `src/lib/errorCatalog.ts` (and `ErrorCode` in `src/lib/errors.ts` for new API codes).
2. Run `npm run generate:sdk-errors`.
3. Commit both the catalog change and regenerated `src/sdk/errors.generated.ts`.
4. Run `npm test -- sdk` to verify parity.

---

## Running Tests

```bash
npm test
npm test -- sdk
npm run test:coverage
```
