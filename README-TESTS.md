# Backend Testing Guide

This document provides comprehensive guidance for running tests locally and ensuring CI parity for the Credence Backend.

## Overview

The Credence Backend includes multiple test suites that validate different aspects of the system:

### Test Categories

- **Integration Tests** - Database repository operations and constraints
- **Unit Tests** - Individual service and utility functions  
- **Repository Tests** - Specific repository functionality
- **RBAC Tests** - Role-based access control
- **Route Tests** - API endpoint testing

### Key Components Tested

- **IdentitiesRepository** - Core identity management
- **BondsRepository** - Bond creation and management
- **AttestationsRepository** - Attestation scoring system
- **SlashEventsRepository** - Slashing event tracking
- **ScoreHistoryRepository** - Score change history
- **AuditLogsRepository** - Audit trail functionality
- **Admin Services** - Administrative operations
- **Governance Routes** - Governance functionality
- **Dispute Routes** - Dispute management
- **Evidence Routes** - Evidence handling

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

## Local Test Running

### Prerequisites

- **Node.js 20+** - Required runtime environment
- **Docker Desktop** - For testcontainers and docker-compose database setup
- **PostgreSQL client tools** - Optional, for manual database inspection

### Environment Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Verify test configuration
cat .env | grep -E "(DATABASE|TEST)"
```

### Test Commands

#### Basic Test Execution

```bash
# Run all tests (uses testcontainers automatically)
npm test

# Run tests in watch mode for development
npm run test:watch

# Run specific test file
npm test -- tests/integration/repositories.test.ts

# Run tests with verbose output
npm test -- --reporter=verbose
```

#### Coverage Reporting

```bash
# Run tests with coverage (standard 75% thresholds)
npm run coverage
npm run test:coverage

# Run audit-sensitive coverage (95% thresholds)
npm run coverage:audit

# Generate coverage report without running tests
npm run coverage -- --reporter=html
```

#### Database Setup Options

**Option 1: Testcontainers (Recommended)**
```bash
# Automatic database provisioning
npm test
```

**Option 2: Docker Compose**
```bash
# Start test database
docker-compose -f docker-compose.test.yml up -d

# Run tests with external database
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test npm test

# Stop database
docker-compose -f docker-compose.test.yml down
```

**Option 3: External PostgreSQL**
```bash
# Set your database URL
export TEST_DATABASE_URL=postgresql://user:pass@host:port/database

# Run tests
npm test
```

### Test Configuration Files

- **vitest.config.ts** - Main test configuration (75% coverage thresholds)
- **vitest.audit.config.ts** - Audit-sensitive configuration (95% coverage thresholds)
- **docker-compose.test.yml** - Test database container configuration

### Running Specific Test Suites

```bash
# Integration tests
npm test -- tests/integration/

# Repository tests
npm test -- tests/repositories/

# RBAC tests
npm test -- tests/rbac.test.ts

# All repository tests (integration + standalone)
npm test -- tests/integration/repositories.test.ts tests/repositories/
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

## CI Parity Guide

### GitHub Actions Configuration

The test suite runs automatically on GitHub Actions with the following triggers:

- **Push events** to `main`, `develop`, and `test/repository-integration-tests` branches
- **Pull requests** targeting `main` and `develop` branches
- **Manual workflow dispatch** for on-demand testing

### CI Environment Specifications

```yaml
# .github/workflows/test.yml
runs-on: ubuntu-latest
node-version: "20"
database: postgres:16-alpine
```

### CI Database Configuration

The CI uses PostgreSQL 16 with the following setup:

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
    ports:
      - 5432:5432
```

### CI Test Execution Steps

1. **Checkout** - Repository code checkout
2. **Node.js Setup** - Node 20 with npm cache
3. **Dependencies** - `npm ci` for clean install
4. **Database Wait** - PostgreSQL health check
5. **Test Run** - `npm test` with TEST_DATABASE_URL
6. **Coverage** - `npm run coverage` 
7. **Audit Coverage** - `npm run coverage:audit` (95% thresholds)
8. **Upload** - Coverage reports to Codecov

### Ensuring Local-CI Parity

#### Database Parity

**Local (docker-compose.test.yml):**
```yaml
ports:
  - "5433:5432"  # Different port to avoid conflicts
tmpfs:
  - /var/lib/postgresql/data:rw,noexec,nosuid,size=100m
```

**CI (.github/workflows/test.yml):**
```yaml
ports:
  - 5432:5432  # Standard port
# No tmpfs - uses default storage
```

#### Coverage Parity

**Local Development:**
```bash
# Standard coverage (75% thresholds)
npm run coverage

# Audit coverage (95% thresholds) 
npm run coverage:audit
```

**CI Execution:**
```bash
# Both standard and audit coverage run
npm run coverage
npm run coverage:audit
```

#### Environment Variables

**Required for CI parity:**
```bash
# CI uses this exact URL
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5432/credence_test

# Local development typically uses
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test
```

### Coverage Thresholds

#### Standard Configuration (vitest.config.ts)
```typescript
thresholds: {
  statements: 75,
  branches: 75,
  functions: 65,
  lines: 75,
}
```

#### Audit Configuration (vitest.audit.config.ts)
```typescript
thresholds: {
  statements: 95,
  lines: 95,
}
```

#### CI Enforcement
- **Standard tests** must meet 75% thresholds
- **Audit-sensitive tests** must meet 95% thresholds
- **Codecov integration** tracks coverage over time
- **CI fails** if thresholds are not met

### Troubleshooting CI Parity Issues

#### Port Conflicts
```bash
# If local tests use different port, match CI port
export TEST_DATABASE_URL=postgresql://credence:credence@localhost:5432/credence_test
```

#### Coverage Differences
```bash
# Check which files are included/excluded
npm run coverage -- --reporter=text-summary

# Run audit coverage locally to match CI
npm run coverage:audit
```

#### Database Version Mismatches
```bash
# Ensure local PostgreSQL version matches CI
docker pull postgres:16-alpine
docker-compose -f docker-compose.test.yml down
docker-compose -f docker-compose.test.yml up -d
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

## Advanced Testing

### Test Categories and Coverage

#### Integration Tests
- **Location**: `tests/integration/`
- **Focus**: Database operations, constraints, relationships
- **Coverage**: Repository CRUD operations, cascade behavior
- **Database**: PostgreSQL with testcontainers

#### Unit Tests
- **Location**: `src/**/*.test.ts`
- **Focus**: Individual functions and services
- **Coverage**: Business logic, utility functions
- **Database**: Mocked or in-memory

#### RBAC Tests
- **Location**: `tests/rbac.test.ts`
- **Focus**: Role-based access control
- **Coverage**: Permission validation, authorization
- **Database**: Integration with test data

#### Route Tests
- **Location**: `tests/routes/`
- **Focus**: API endpoint functionality
- **Coverage**: HTTP handlers, request/response validation
- **Database**: Integration with repositories

### Test Data Management

#### Database Reset Strategy
```typescript
// Each test runs with clean state
beforeEach(async () => {
  await resetDatabase();
});

// Tables are truncated between tests
// No test depends on data from other tests
```

#### Test Data Patterns
- **Predictable identifiers**: `GIDENTITY_1`, `GBOND_OWNER`
- **Isolated scenarios**: Each test creates its own data
- **Realistic values**: Meaningful but deterministic test data
- **Cleanup validation**: Verify proper data deletion

### Performance and Optimization

#### Test Execution
```bash
# Sequential execution to avoid conflicts
npm test -- --test-concurrency=1

# Parallel execution for faster runs (when safe)
npm test -- --test-concurrency=4
```

#### Database Performance
- **tmpfs storage**: Faster I/O for test database
- **Connection pooling**: Reused database connections
- **Minimal data**: Only necessary test data created
- **Automatic cleanup**: Prevents resource leaks

## Contributing

### Adding New Tests

1. **Follow existing patterns** - Use established test structure and naming
2. **Include all scenarios** - Test success cases, error cases, and edge cases
3. **Validate constraints** - Test database constraints and relationships
4. **Ensure cleanup** - Proper teardown in test lifecycle hooks
5. **Verify coverage** - Maintain required coverage thresholds

### Test Guidelines

#### Best Practices
- **Descriptive names** - Test names should explain the scenario
- **Comprehensive coverage** - Include positive and negative test cases
- **Edge case testing** - Test boundary conditions and error scenarios
- **Error validation** - Check specific error codes for constraint violations
- **Clear assertions** - Use meaningful assertions with helpful failure messages

#### Code Organization
```typescript
describe('feature being tested', () => {
  describe('specific scenario', () => {
    it('should do expected behavior', async () => {
      // Arrange - setup test data
      // Act - execute the operation
      // Assert - verify results
    });
  });
});
```

### Coverage Requirements

#### Standard Tests (vitest.config.ts)
- **Statements**: 75%+ required
- **Branches**: 75%+ required  
- **Functions**: 65%+ required
- **Lines**: 75%+ required

#### Audit-Sensitive Tests (vitest.audit.config.ts)
- **Statements**: 95%+ required
- **Lines**: 95%+ required
- **Functions**: 95%+ required
- **Branches**: 95%+ required

#### Coverage Exclusions
- Test files (`**/*.test.ts`, `**/*.spec.ts`)
- Type definition files (`**/*.d.ts`)
- Index/barrel files (`**/index.ts`)
- Utility files requiring live dependencies (`src/utils/**`)
- Infrastructure code (`src/index.ts`)

## Quick Reference

### Essential Commands

```bash
# Run all tests
npm test

# Watch mode for development
npm run test:watch

# Coverage reports
npm run coverage
npm run coverage:audit

# Specific test suites
npm test -- tests/integration/
npm test -- tests/rbac.test.ts
```

### Environment Setup

```bash
# Database with docker-compose
docker-compose -f docker-compose.test.yml up -d
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test npm test

# Automatic testcontainers
npm test

# External database
export TEST_DATABASE_URL=postgresql://user:pass@host:port/database
npm test
```

### CI Parity Checklist

- [ ] Use same PostgreSQL version (16-alpine)
- [ ] Match database credentials (credence/credence)
- [ ] Run both standard and audit coverage
- [ ] Verify coverage thresholds locally
- [ ] Test with CI database URL format
- [ ] Ensure clean test isolation
