# Local Testing Guide

This guide provides detailed instructions for setting up and running tests locally in the Credence Backend development environment.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run tests (automatic database setup)
npm test

# 3. Check coverage
npm run coverage
```

## Environment Setup

### Prerequisites

- **Node.js 20+** - Download from [nodejs.org](https://nodejs.org/)
- **Docker Desktop** - Download from [docker.com](https://www.docker.com/products/docker-desktop/)
- **Git** - For version control

### Environment Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit .env file with your settings
# Most tests use default values, but you can override:
# TEST_DATABASE_URL - Custom database connection
# NODE_ENV - Environment (default: test)
```

## Database Setup Options

### Option 1: Testcontainers (Recommended)

**Pros**: Automatic setup, no manual configuration, isolated environment
**Cons**: Requires Docker, slightly slower startup

```bash
# Just run tests - database is created automatically
npm test

# Watch mode with automatic database
npm run test:watch
```

### Option 2: Docker Compose

**Pros**: Persistent database, faster subsequent runs, manual control
**Cons**: Manual setup, port conflicts possible

```bash
# Start test database
docker-compose -f docker-compose.test.yml up -d

# Verify database is ready
docker-compose -f docker-compose.test.yml exec test-db pg_isready

# Run tests
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test npm test

# Stop when done
docker-compose -f docker-compose.test.yml down
```

### Option 3: External PostgreSQL

**Pros**: Use existing database, shared across projects
**Cons**: Manual setup, potential conflicts with other work

```bash
# Set environment variable
export TEST_DATABASE_URL=postgresql://username:password@host:port/database

# Run tests
npm test
```

## Test Categories

### Integration Tests

Database-focused tests that validate repository operations:

```bash
# Run all integration tests
npm test -- tests/integration/

# Run specific integration test
npm test -- tests/integration/repositories.test.ts

# Run with verbose output
npm test -- tests/integration/ --reporter=verbose
```

### Unit Tests

Individual component tests:

```bash
# Run all unit tests in src directory
npm test -- src/**/*.test.ts

# Run specific unit test
npm test -- src/services/identity.test.ts
```

### RBAC Tests

Role-based access control tests:

```bash
# Run RBAC tests
npm test -- tests/rbac.test.ts
```

### Repository Tests

Standalone repository tests:

```bash
# Run repository tests
npm test -- tests/repositories/
```

## Coverage Reporting

### Standard Coverage

```bash
# Generate coverage report (75% thresholds)
npm run coverage

# View HTML report
open coverage/index.html
```

### Audit Coverage

```bash
# Generate audit coverage (95% thresholds for sensitive code)
npm run coverage:audit

# View audit coverage summary
cat coverage/lcov.info | grep LF:
```

### Coverage Configuration

The project uses two coverage configurations:

1. **Standard** (`vitest.config.ts`) - 75% thresholds for general code
2. **Audit** (`vitest.audit.config.ts`) - 95% thresholds for security-sensitive code

## Development Workflow

### Watch Mode

```bash
# Run tests in watch mode
npm run test:watch

# Watch specific test file
npm run test:watch -- tests/integration/repositories.test.ts

# Watch with coverage
npm run test:watch -- --coverage
```

### Debugging Tests

```bash
# Run with verbose output
npm test -- --reporter=verbose

# Run specific test pattern
npm test -- --testNamePattern="identities repository"

# Run tests with debugger
node --inspect-brk node_modules/.bin/vitest run
```

### Database Debugging

```bash
# Connect to test database (docker-compose)
psql -h localhost -p 5433 -U credence -d credence_test

# View tables
\dt

# View specific table
\d+ identities

# Export database schema
pg_dump -h localhost -p 5433 -U credence -s credence_test > schema.sql
```

## Common Issues and Solutions

### Docker Issues

**Problem**: Docker not running
```bash
# Solution: Start Docker Desktop
# Check Docker status
docker version
```

**Problem**: Port conflicts
```bash
# Solution: Check what's using the port
netstat -tulpn | grep 5433

# Or use different port in docker-compose.test.yml
```

**Problem**: Permission denied
```bash
# Solution: Add user to docker group
sudo usermod -aG docker $USER
# Then restart your terminal
```

### Database Issues

**Problem**: Database connection failed
```bash
# Check database URL
echo $TEST_DATABASE_URL

# Test connection manually
psql $TEST_DATABASE_URL -c "SELECT 1;"
```

**Problem**: Tests hang on database startup
```bash
# Check database health
docker-compose -f docker-compose.test.yml exec test-db pg_isready

# Restart database
docker-compose -f docker-compose.test.yml restart
```

### Test Issues

**Problem**: Tests fail with coverage errors
```bash
# Check coverage report
npm run coverage -- --reporter=text-summary

# Run specific failing test
npm test -- --testNamePattern="failing test name"
```

**Problem**: Tests pass locally but fail in CI
```bash
# Match CI environment exactly
export TEST_DATABASE_URL=postgresql://credence:credence@localhost:5432/credence_test

# Use same PostgreSQL version
docker pull postgres:16-alpine
```

## Performance Optimization

### Faster Test Runs

```bash
# Use tmpfs for faster I/O (already configured in docker-compose.test.yml)
# Run tests in parallel (when safe)
npm test -- --test-concurrency=4

# Skip coverage for faster iteration
npm test -- --coverage.enabled=false
```

### Database Optimization

```bash
# Use connection pooling (configured in test setup)
# Use in-memory database for simple tests
# Reuse database container across test runs
```

## CI Parity

### Matching CI Environment

To ensure your local tests match CI behavior:

```bash
# Use CI database URL format
export TEST_DATABASE_URL=postgresql://credence:credence@localhost:5432/credence_test

# Run same test commands as CI
npm test
npm run coverage
npm run coverage:audit
```

### Pre-commit Validation

```bash
# Run full test suite before committing
npm run lint
npm test
npm run coverage
npm run coverage:audit
```

## Troubleshooting Checklist

Before reporting issues, verify:

- [ ] Node.js 20+ installed
- [ ] Docker Desktop running
- [ ] Dependencies installed (`npm install`)
- [ ] Environment configured (`.env` file)
- [ ] Database connection working
- [ ] Tests run with clean state
- [ ] Coverage thresholds met
- [ ] CI environment matched

## Getting Help

If you encounter issues:

1. Check this guide for common solutions
2. Review test output for specific error messages
3. Check GitHub Issues for similar problems
4. Create new issue with:
   - Error message
   - Environment details
   - Steps to reproduce
   - Expected vs actual behavior
