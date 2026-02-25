# Graceful Shutdown

The server supports graceful shutdown on `SIGTERM` and `SIGINT`.

## Behavior

1. Receive signal.
2. Mark server as draining and reject new requests with `503 ServiceUnavailable`.
3. Stop accepting new connections (`server.close`).
4. Wait for in-flight requests to finish.
5. Close DB pool and Redis client.
6. Exit process.

## Required environment variable

`SHUTDOWN_TIMEOUT_MS` must be set to a positive integer.

If missing or invalid, startup fails with a configuration error.

## Implementation files

- `src/lifecycle/gracefulShutdown.ts`
- `src/server.ts`
- `src/infra/resources.ts`

## Tests

- `src/lifecycle/gracefulShutdown.test.ts`
- `src/server.test.ts`
