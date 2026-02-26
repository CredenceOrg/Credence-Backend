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
  bondDuration: string | null
  active: boolean
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

## Error Handling

All methods throw `CredenceApiError` on failure. The error includes the HTTP status code and response body.

```typescript
import { CredenceApiError } from './src/sdk/index.js'

try {
  await client.getTrustScore('0xbad')
} catch (err) {
  if (err instanceof CredenceApiError) {
    console.error(err.status) // HTTP status code (0 for network/timeout errors)
    console.error(err.body)   // Raw response body
    console.error(err.message)
  }
}
```

Error scenarios:

| Scenario            | `status` | `message`                          |
|---------------------|----------|------------------------------------|
| HTTP error          | 4xx/5xx  | `HTTP {status}: {statusText}`      |
| Invalid JSON        | 200      | `Invalid JSON response`            |
| Network failure     | 0        | `Network error: {details}`         |
| Request timeout     | 0        | `Request timed out: {url}`         |

## Running Tests

```bash
npm test
npm run test:coverage
```
