# Repository & E2E Integration Tests

This suite validates database repositories and end-to-end flows against real PostgreSQL and Redis.

## Covered scenarios

- **Identities & Bonds**: CRUD and business logic for identity and bond state.
- **Attestations & Slashing**: Validation of attestation records and slashing events.
- **E2E State Sync**: Full flow from Horizon event ingestion -> DB persistence -> Trust Score recomputation -> Redis Cache invalidation.
- **Caching**: Validation of Redis cache population and invalidation.
- **Database Constraints**: Check constraints, unique constraints, and FK cascade behavior.

## Running tests

The tests require PostgreSQL and Redis. They can be provided via environment variables or automatically started using Testcontainers (requires a working Docker runtime).

### With External Instances

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/credence_test \
REDIS_URL=redis://localhost:6379 \
npm test tests/integration/
```

### With Testcontainers (Automatic)

```bash
# Requires Docker
npm test tests/integration/
```

## Coverage Report

```bash
npm run coverage
```
