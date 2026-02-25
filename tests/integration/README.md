# Repository Integration Tests

This suite validates database repositories against real PostgreSQL.

## Covered scenarios

- Identities repository CRUD and list methods
- Bonds repository CRUD and list-by-identity query methods
- Attestations repository CRUD and list-by-subject / list-by-bond query methods
- Slash events repository CRUD, list-by-bond, and aggregate query methods
- Score history repository create, list-by-identity, latest-entry, and delete methods
- Database constraints (check constraints, unique constraints, and FK constraints)
- Foreign key cascade behavior across related tables
- Test isolation via table truncation between test cases

## Running tests

Use an external PostgreSQL instance:

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/credence_test npm run test:integration
```

Or let the suite create a temporary PostgreSQL container via Docker/Testcontainers:

```bash
npm run test:integration
```

Coverage report:

```bash
npm run coverage
```
