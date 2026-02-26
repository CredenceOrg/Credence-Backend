# Stellar/Soroban Client Adapter

This project includes a dedicated Soroban RPC adapter in `src/clients/soroban.ts`.

## Goals

- Encapsulate Soroban network configuration (`rpcUrl`, `network`, `contractId`)
- Provide a stable facade for contract interactions
- Apply consistent timeout, retry, and error handling
- Keep transport logic testable via dependency injection

## API

### `createSorobanClient(config, deps?)`

Creates a `SorobanClient` instance.

### `getIdentityState(address)`

Fetches identity state from the configured contract using a `getContractData` RPC call shape.

### `getContractEvents(cursor?)`

Fetches contract-scoped events using `getEvents`, and returns:

- `events`: parsed event array
- `cursor`: normalized next cursor (`latestCursor` or `cursor` or `null`)

## Configuration

Example environment variables:

```bash
SOROBAN_RPC_URL=https://rpc.testnet.stellar.org
SOROBAN_NETWORK=testnet
SOROBAN_CONTRACT_ID=CDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
SOROBAN_TIMEOUT_MS=5000
```

Example initialization:

```ts
import { createSorobanClient } from '../src/clients/soroban.js'

const soroban = createSorobanClient({
  rpcUrl: process.env.SOROBAN_RPC_URL!,
  network: (process.env.SOROBAN_NETWORK as 'testnet' | 'mainnet') ?? 'testnet',
  contractId: process.env.SOROBAN_CONTRACT_ID!,
  timeoutMs: Number(process.env.SOROBAN_TIMEOUT_MS ?? 5000),
  retry: {
    maxAttempts: 3,
    baseDelayMs: 200,
    backoffMultiplier: 2,
    maxDelayMs: 2000,
  },
})
```

## Error handling

The adapter throws `SorobanClientError` with a typed `code`:

- `CONFIG_ERROR`
- `NETWORK_ERROR`
- `TIMEOUT_ERROR`
- `HTTP_ERROR`
- `RPC_ERROR`
- `PARSE_ERROR`

Retries are attempted for:

- transport failures
- timeouts
- HTTP `408`, `429`, and `5xx`
- retryable RPC errors (`-32004`, `-32005`)

All other errors fail fast.

## Testing

Tests live in `src/clients/soroban.test.ts` and use mocked `fetchFn` and `sleepFn` to validate:

- success paths for both facade methods
- timeout behavior
- retry/backoff behavior
- non-retryable failures
- parse and payload-shape errors

Run tests with:

```bash
npm test
```
