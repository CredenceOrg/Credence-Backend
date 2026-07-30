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

To prevent sustained Soroban RPC failures from exhausting retry budgets and causing cascading failures, a per-host circuit breaker wraps the client. Implemented in `src/clients/circuitBreaker.ts`; constants live in `src/config/sorobanConstants.ts`.

### States

| State | Numeric | Behaviour |
|---|---|---|
| `CLOSED` | `0` | Normal execution. Failures are counted toward the threshold. |
| `OPEN` | `1` | All requests rejected immediately — no network contact. |
| `HALF_OPEN` | `2` | Exactly one probe request allowed. Success → `CLOSED`; failure → `OPEN`. |

### Timing model (issue #577)

The breaker uses **two independent time windows** after tripping:

```
trip
 │
 ├─── 0 s ──────────────── OPEN (fail-fast) ─────────────── 10 s ──┐
 │                                                                   │
 └─── still OPEN (waiting for probe window) ──────────────── 30 s ──┴──→ HALF_OPEN
```

| Phase | Duration | Effect |
|---|---|---|
| Fail-fast window | `SOROBAN_CIRCUIT_BREAKER_OPEN_WINDOW_MS` (default **10 s**) | Every request is rejected immediately without touching the network. |
| Probe wait | `SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS` (default **30 s**) | After this delay from trip time the first probe is allowed. Breaker stays `OPEN` until this elapses. |

The two windows are independently tunable. `halfOpenAfterMs` must be ≥ `openWindowMs`; if set lower it is silently clamped up.

### Configuration

All constants are defined in `src/config/sorobanConstants.ts` and validated through the Zod schema in `src/config/index.ts`. Never hardcode these values in client code — import or read from config.

| Environment variable | Type | Default | Description |
|---|---|---|---|
| `SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | integer ≥ 1 | `5` | Consecutive failures needed to trip the breaker. |
| `SOROBAN_CIRCUIT_BREAKER_OPEN_WINDOW_MS` | integer ≥ 1000 | `10000` | Fail-fast duration (ms) after tripping. |
| `SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS` | integer ≥ 1000 | `30000` | Delay (ms) from trip before the first probe is allowed. |
| `SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS` | integer ≥ 1000 | — | **Deprecated.** Maps to `halfOpenAfterMs` when the new variable is absent. |

**Per-instance override** via `SorobanClientConfig.circuitBreaker`:

```ts
createSorobanClient({
  rpcUrl: '...',
  network: 'mainnet',
  contractId: '...',
  circuitBreaker: {
    failureThreshold: 3,
    openWindowMs: 10_000,    // fail-fast for 10 s
    halfOpenAfterMs: 30_000, // allow probe after 30 s
  },
})
```

#### Migration from the old API

`cooldownPeriodMs` in both the env var and the per-instance config is accepted unchanged. It maps to `halfOpenAfterMs`. No code changes are required for existing callers — the behaviour difference is:

| Old default | New default |
|---|---|
| Single `cooldownPeriodMs = 10 000 ms` (became HALF_OPEN after 10 s) | `openWindowMs = 10 000 ms` + `halfOpenAfterMs = 30 000 ms` (becomes HALF_OPEN after 30 s) |

If you relied on a 10 s probe window, set `SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS=10000` explicitly.

### Metrics

Exposes the current state of the breaker for each host via the Prometheus metric:

- `soroban_circuit_state{host="..."}`: State values are mapped numerically:
  - `0` = `CLOSED`
  - `1` = `OPEN`
  - `2` = `HALF_OPEN`

### Alerts

A Prometheus alerting rule fires when any host's circuit stays `OPEN` for more than 2 minutes:

- Alert Name: `SorobanCircuitBreakerOpen`
- Expression: `soroban_circuit_state == 1`
- Duration: `2m`
- Severity: `critical`

## Testing

Tests live in `src/clients/__tests__/soroban.test.ts` and `src/clients/__tests__/circuitBreaker.test.ts`. They validate:

- success paths for both facade methods
- timeout behavior
- retry/backoff behavior
- non-retryable failures
- parse and payload-shape errors
- circuit breaker state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
- fail-fast window: requests rejected for 10 s after tripping, no network contact
- probe window: state stays OPEN between 10 s and 30 s; HALF_OPEN opens at 30 s
- probe success closes the breaker; probe failure reopens it
- circuit breaker multi-host isolation
- circuit breaker concurrency limits during HALF_OPEN probes
- backwards-compatible `cooldownPeriodMs` mapping

Run tests with:

```bash
npm test
```
