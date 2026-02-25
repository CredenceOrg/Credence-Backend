# Integration Tests for DB Repositories

This document describes the comprehensive integration test suite for all database repositories in the Credence Backend.

## Overview

The integration tests validate all CRUD operations, constraints, and relationships across the following repositories:

- **IdentitiesRepository** - Core identity management
- **BondsRepository** - Bond creation and management
- **AttestationsRepository** - Attestation scoring system
- **SlashEventsRepository** - Slashing event tracking
- **ScoreHistoryRepository** - Score change history

## Test Coverage

The test suite achieves **95%+ code coverage** and includes:

### Core Repository Operations

- ✅ Create, Read, Update, Delete (CRUD) operations
- ✅ List and query methods (by identity, bond, subject etc.)
- ✅ Aggregation methods (total slashed amounts, latest scores)
- ✅ Update operations with proper versioning

### Database Constraints & Integrity

- ✅ Primary key constraints
- ✅ Foreign key constraints and cascading deletes
- ✅ Check constraints (scores 0-100, amounts >= 0)
- ✅ Unique constraints (attestation uniqueness per bond)
- ✅ Non-empty string validation

### Relationship Testing

- ✅ Cross-table foreign key relationships
- ✅ Cascade deletion behavior
- ✅ Referential integrity enforcement

## Test Infrastructure

### Database Setup

- **Test Database**: PostgreSQL 16 in Docker container
- **Isolation**: Each test runs with clean database state
- **Lifecycle**: Automatic setup/teardown with proper cleanup

### Test Technologies

- **Runtime**: Node.js native test runner
- **TypeScript**: tsx for seamless TS support
- **Containers**: testcontainers for database provisioning
- **Coverage**: c8 for comprehensive coverage reporting

## Running Tests

### Prerequisites

- Node.js 20+
- Docker Desktop (for local testing)
- PostgreSQL client tools (optional)

### Local Development

#### Option 1: Using testcontainers (automatic)

```bash
npm test
```

This automatically starts PostgreSQL in a Docker container.

#### Option 2: Using docker-compose

```bash
# Start test database
docker-compose -f docker-compose.test.yml up -d

# Run tests with external database
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test npm test

# Stop database
docker-compose -f docker-compose.test.yml down
```

#### Option 3: Using external PostgreSQL

```bash
# Set your database URL
export TEST_DATABASE_URL=postgresql://user:pass@host:port/database

# Run tests
npm test
```

### Coverage Reporting

```bash
# Run tests with coverage check (requires 95%)
npm run coverage

# Coverage files generated in ./coverage/
```

## Test Structure

### Test Organization

```
tests/
├── integration/
│   ├── repositories.test.ts      # Main test suite
│   ├── testDatabase.ts          # Database utilities
│   └── README.md               # This file
```

### Test Categories

#### 1. Repository CRUD Tests

Each repository is tested for complete CRUD functionality:

```typescript
describe('identities repository', () => {
  it('supports CRUD and list query', async () => {
    // Create identity
    const created = await identitiesRepository.create({...})

    // Read identity
    const found = await identitiesRepository.findByAddress(...)

    // Update identity
    const updated = await identitiesRepository.update(...)

    // List identities
    const all = await identitiesRepository.list()

    // Delete identity
    await identitiesRepository.delete(...)
  })
})
```

#### 2. Constraint Validation Tests

Database constraints are thoroughly tested:

```typescript
it("enforces unique and non-empty address constraints", async () => {
	// Test unique constraint violation
	await expectPgError(
		identitiesRepository.create({ address: "DUPLICATE" }),
		"23505", // PostgreSQL unique violation code
	);

	// Test check constraint violation
	await expectPgError(
		identitiesRepository.create({ address: "   " }),
		"23514", // PostgreSQL check violation code
	);
});
```

#### 3. Cascade Behavior Tests

Foreign key cascading is validated:

```typescript
it('cascades dependent rows from identities to all child tables', async () => {
  // Create identity with dependent records
  await identitiesRepository.create({...})
  const bond = await bondsRepository.create({...})
  const attestation = await attestationsRepository.create({...})

  // Delete parent identity
  await identitiesRepository.delete(address)

  // Verify cascaded deletions
  assert.equal(await bondsRepository.findById(bond.id), null)
  assert.equal(await attestationsRepository.findById(attestation.id), null)
})
```

## Test Data Management

### Clean State Policy

- Each test starts with completely empty tables
- `resetDatabase()` truncates all tables between tests
- No test depends on data from other tests

### Test Data Patterns

- Predictable, meaningful test identifiers (e.g., 'GIDENTITY_1', 'GBOND_OWNER')
- Isolated test data per test scenario
- Realistic but deterministic values

## Continuous Integration

### GitHub Actions

The test suite runs automatically on:

- All pushes to main/develop branches
- All pull requests
- Manual workflow dispatch

### CI Environment

- Ubuntu latest with PostgreSQL 16
- Coverage thresholds enforced (95%+ required)
- Codecov integration for coverage reporting

### CI Database Setup

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_DB: credence_test
      POSTGRES_USER: credence
      POSTGRES_PASSWORD: credence
    options: >-
      --health-cmd "pg_isready -U credence -d credence_test"
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

## Debugging Tests

### Verbose Output

```bash
# Run with detailed test output
npm test -- --reporter=verbose
```

### Database Inspection

```bash
# Connect to test database (when using docker-compose)
psql -h localhost -p 5433 -U credence -d credence_test

# Inspect schema
\dt
\d+ table_name
```

### Common Issues

- **Docker not running**: Ensure Docker Desktop is started
- **Port conflicts**: Test database uses port 5433 to avoid conflicts
- **Permissions**: Ensure current user can access Docker

## Performance Considerations

### Test Execution Time

- Full suite completes in ~30-60 seconds
- Database startup adds ~10-15 seconds (first time)
- Tests run sequentially to avoid conflicts (`--test-concurrency=1`)

### Resource Usage

- PostgreSQL container uses minimal resources
- Temporary storage for faster test execution
- Automatic cleanup prevents resource leaks

## Contributing

### Adding New Tests

1. Follow existing test patterns and naming conventions
2. Include both success and error scenarios
3. Test database constraints and relationships
4. Ensure proper cleanup in test lifecycle hooks
5. Verify coverage remains above 95%

### Test Guidelines

- Use descriptive test names that explain the scenario
- Include positive and negative test cases
- Test edge cases and boundary conditions
- Validate error codes for database constraint violations
- Use meaningful assertions with clear failure messages

### Coverage Requirements

- **Lines**: 95%+ required
- **Functions**: 95%+ required
- **Branches**: 95%+ required
- **Statements**: 95%+ required
