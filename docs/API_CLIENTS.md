# API Client Libraries

**Audience:** Downstream integrators building applications on top of the Credence API.

This document lists the officially sanctioned and recommended client libraries for interacting with the Credence Backend API. Using a recommended client ensures you benefit from our API stability guarantees and receive timely updates.

---

## Official TypeScript/JavaScript SDK

The primary, first-party client is the TypeScript/JavaScript SDK, which is co-located in this repository. It is generated directly from our OpenAPI specification and is always in sync with the API.

- **Source:** `src/sdk/`
- **Documentation:** `docs/sdk.md`

### Versioning

The SDK is versioned in lockstep with the API. A major version bump in the API (e.g., `v1.x` to `v2.0`) corresponds to a major version bump in the SDK. This alignment is part of our API Stability contract.

| API Version | SDK Version | Compatibility |
|-------------|-------------|---------------|
| `1.5.x`     | `1.5.x`     | Fully compatible |
| `2.0.0`     | `2.0.0`     | Breaking changes from `v1` |

### Quick Start

To use the SDK, you can import it directly if you are working within this monorepo.

```typescript
import { CredenceClient } from './src/sdk/index.js';

const client = new CredenceClient({
  baseUrl: 'https://api.credence.org/v1',
  // apiKey is optional for public endpoints
});

async function getTrustScore(address: string) {
  try {
    const trustInfo = await client.getTrustScore(address);
    console.log(`Trust score for ${address}:`, trustInfo.score);
    return trustInfo;
  } catch (error) {
    console.error('Failed to fetch trust score:', error);
  }
}
```

---

## Other Languages (via OpenAPI Generator)

For languages other than TypeScript/JavaScript, we recommend generating a client from our official OpenAPI specification. This ensures your client is built directly from the API's source-of-truth contract.

- **OpenAPI Spec:** [`docs/openapi.yaml`](./openapi.yaml)
- **Generation Guide:** `docs/OPENAPI.md`

### Example: Generating a Python Client

You can use a tool like OpenAPI Generator to create a client for your preferred language.

```bash
# 1. Install the generator CLI
npm install @openapitools/openapi-generator-cli -g

# 2. Generate the Python client from our spec
openapi-generator-cli generate \
  -i docs/openapi.yaml \
  -g python \
  -o ./generated/credence-python-client
```

This command creates a full-featured Python client in the `generated/credence-python-client` directory, complete with models, API instances, and authentication handling.

---

## Community Libraries

We do not currently track or sanction any third-party community libraries. If you are a maintainer of a library you believe should be listed here, please open an issue to start a discussion.

