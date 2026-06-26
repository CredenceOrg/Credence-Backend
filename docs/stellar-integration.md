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

## Circuit Breaker

To prevent sustained Soroban RPC failures from exhausting retry budgets and causing cascading failures, a per-host circuit breaker is integrated into the client.

### States
- **CLOSED (0)**: Normal request execution.
- **OPEN (1)**: Rejects outbound requests immediately, failing fast without hitting the network.
- **HALF_OPEN (2)**: Allows a single probe request to pass through. A successful probe transitions the breaker to CLOSED. A failed probe transitions it back to OPEN.

### Configuration
Configure the circuit breaker using the following environment variables:
- `SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD`: The number of consecutive failures needed to open the breaker (default: `5`).
- `SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS`: The cooldown period in milliseconds before attempting a probe request in the `HALF_OPEN` state (default: `10000`).

### Metrics
Exposes the current state of the breaker for each host via the Prometheus metric:
- `soroban_circuit_state{host="..."}`: State values are mapped numerically:
  - `0` = `CLOSED`
  - `1` = `OPEN`
  - `2` = `HALF_OPEN`

### Alerts
A Prometheus alerting rule is set up to fire when any host's circuit stays `OPEN` for more than 2 minutes:
- Alert Name: `SorobanCircuitBreakerOpen`
- Expression: `soroban_circuit_state == 1`
- Duration: `2m`
- Severity: `critical`

## Testing

Tests live in `src/clients/soroban.test.ts` and `src/clients/__tests__/circuitBreaker.test.ts`. They validate:

- success paths for both facade methods
- timeout behavior
- retry/backoff behavior
- non-retryable failures
- parse and payload-shape errors
- circuit breaker state transitions (CLOSED, OPEN, HALF_OPEN)
- circuit breaker multi-host isolation
- circuit breaker concurrency limits during HALF_OPEN probes

Run tests with:

```bash
npm test
```
