# Chaos Testing Guide

This repository includes a dedicated chaos test harness for validating resilience against:

- Postgres restarts and connection recovery
- Redis stalls and fail-open behavior
- Horizon endpoint outages and listener recovery

## Files and services

- `docker-compose.test.yml`
  - `test-db` — Postgres 16
  - `test-redis` — Redis 7
  - `test-horizon` — Horizon stub service used by the listener recovery test

- `tests/chaos/chaosHelpers.ts` — Docker Compose helpers and wait helpers for the chaos tests
- `tests/chaos/postgresFailover.test.ts` — DB restart/failover validation for trust scoring
- `tests/chaos/redisAndOutboxChaos.test.ts` — Redis stall validation plus `/api/trust`, `/api/bond`, and outbox reinjection flows
- `tests/chaos/horizonRecovery.test.ts` — Horizon listener restart/recovery validation
- `tests/chaos/horizon-stub.js` — Local Horizon-compatible stub for controlled failure and event replay

## Running the chaos suite

Run the chaos tests with:

```bash
npm run test:chaos
```

The suite brings up the test stack from `docker-compose.test.yml` and tears it down automatically.

## When to use

Use this harness when you need to verify that the backend:

- recovers from a Postgres restart without losing service availability
- continues serving rate-limited endpoints when Redis is unavailable
- preserves outbox reinjection capability during cache outages
- resumes Horizon polling after a Horizon endpoint stall

## Notes

- The tests are intentionally run sequentially to avoid service interference.
- The Horizon test uses a lightweight stub service rather than a full Stellar network.
- The Redis and Postgres services are mounted on ports `6380` and `5433` respectively.
