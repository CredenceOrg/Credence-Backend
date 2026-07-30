# New Features Implementation Guide

## Quick Start

This document provides a quick reference for the three newly implemented features.

---

## Feature 1: Property-Based Pagination Tests ✅

**Status**: Complete
**Files**: 
- `src/lib/pagination.test.ts` (270 lines, added property tests)
- `package.json` (added `fast-check`)

**What to do**:
1. Install dependencies: `npm install`
2. Run tests: `npm test -- src/lib/pagination.test.ts`

**Key Test Properties**:
- Offset invariant: `offset == (page-1) * limit`
- Limit clamping: `1 <= limit <= MAX_LIMIT`
- Cursor round-trips are reversible
- Legacy offset fallback works for numeric cursors
- Error accumulation for invalid inputs

**Test Coverage**: 80 edge cases across 10 property-based scenarios

---

## Feature 2: Credit Cost Meter Middleware ✅

**Status**: Complete
**Files**:
- `src/middleware/costMeter.ts` (core middleware)
- `src/middleware/__tests__/costMeter.test.ts` (integration tests)

**Key Functions**:

```typescript
// Deduct credits with optimistic locking
await deductCredits('org-1', 100)

// Refund on error
await refundCredits('org-1', 100)

// Configure cost weights
configureCostMeter({
  defaultCostWeight: 1,
  costWeights: { '/api/verify': 5, '/api/bulk/verify': 10 },
  maxRetries: 3
})

// Resolve weight for a route
const weight = resolveCostWeight('/api/verify')

// Use as middleware
app.use(costMeterMiddleware)
```

**Database Schema**:
```sql
CREATE TABLE org_credits (
  org_id TEXT PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 10000,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
)
```

**Features**:
- ✅ Optimistic locking for concurrent deductions
- ✅ Version-based conflict detection & retries
- ✅ Auto-refund on 5xx responses
- ✅ Graceful handling of missing orgs
- ✅ Configurable cost weights per route

**Test Scenarios** (20+ cases):
- Concurrent deductions maintain consistency
- Version increments on each operation
- Refunds restore balance correctly
- Credit initialization race resolved safely
- Route cost weight resolution

---

## Feature 3: Mandatory Tenant Context Middleware ✅

**Status**: Complete
**Files**:
- `src/middleware/tenantContext.ts` (core middleware)
- `src/middleware/__tests__/tenantContext.test.ts` (unit tests)
- `src/utils/logger.ts` (updated with tenantId logging)

**Key Functions**:

```typescript
// Configure tenant resolution
configureTenantContext({
  allowHeaderFallback: false,
  allowDefaultTenant: false,
  tenantScopedRoutes: ['/api/tenant/:id/.*', '/api/orgs/:id/.*'],
  requiredOnScoped: true
})

// Use middleware
app.use(requireUserAuth)
app.use(tenantContextMiddleware)
app.use(requireTenant) // For tenant-scoped routes

// Get tenant ID from request
const tenantId = getTenantId(req)

// Validate tenant ID format
const isValid = isValidTenantId('my-org')
```

**Tenant Resolution Priority**:
1. Authenticated principal's tenantId (highest)
2. X-Tenant-ID header (if `allowHeaderFallback: true`)
3. Default tenant (if `allowDefaultTenant: true`)

**Tenant ID Format**:
- Pattern: `[a-z0-9][a-z0-9-]*[a-z0-9]`
- Case-insensitive
- Max 255 characters
- Examples: `tenant-1`, `my-org`, `ABC123`

**Logging Integration**:
All logs now include `tenantId` field from AsyncLocalStorage:
```
[2024-01-15T10:30:45.123Z] [INFO] [RequestID: req-123] [CorrelationID: corr-456] [TenantId: tenant-1] - User login
```

**Features**:
- ✅ Derives tenant from auth principal (no silent defaults)
- ✅ Validates tenant ID format
- ✅ Rejects missing tenant on scoped routes (401)
- ✅ Adds tenantId to all structured logs
- ✅ Proper AsyncLocalStorage cleanup
- ✅ Support for multi-tenant deployments

**Test Scenarios** (25+ cases):
- Principal tenant resolution
- Header fallback behavior
- Tenant ID format validation
- Scoped route enforcement
- Enterprise & SaaS flow integration
- Error handling for malformed tenants

---

## Integration Example

```typescript
import express from 'express'
import { requireUserAuth } from './middleware/auth.js'
import { tenantContextMiddleware, requireTenant } from './middleware/tenantContext.js'
import { costMeterMiddleware, configureCostMeter } from './middleware/costMeter.js'

const app = express()

// Configure cost meter
configureCostMeter({
  defaultCostWeight: 1,
  costWeights: {
    'POST /api/verify': 5,
    'POST /api/bulk/verify': 10,
  }
})

// Middleware stack
app.use(requireUserAuth)                    // Authenticate & get tenantId
app.use(tenantContextMiddleware)            // Resolve & validate tenant
app.use(costMeterMiddleware)                // Track costs
app.use(requireTenant)                      // Require tenant for routes

// Route handler
app.post('/api/verify', async (req, res) => {
  const tenantId = getTenantId(req)
  const cost = resolveCostWeight(req.route.path)
  
  await deductCredits(tenantId, cost)
  
  // Handle verification
  res.json({ verified: true })
})
```

---

## Running Tests

After installing dependencies (`npm install`):

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- src/lib/pagination.test.ts
npm test -- src/middleware/__tests__/costMeter.test.ts
npm test -- src/middleware/__tests__/tenantContext.test.ts

# Run with coverage
npm run test:coverage
```

---

## Implementation Notes

### Pagination Tests
- Uses fast-check library for property-based testing
- Generates 100+ random test cases per property by default
- No external dependencies beyond test framework

### Cost Meter
- Requires PostgreSQL database
- Uses optimistic locking pattern (suitable for low-contention workloads)
- For high-concurrency, consider adding Redis-based rate limiting
- Initial balance: 10,000 credits per org

### Tenant Context
- Integrates with existing `requireUserAuth` middleware
- Works with both Express-based auth and auth.ts mock users
- AsyncLocalStorage provides thread-safe context isolation
- tenantId automatically included in all logger output

---

## Migration Steps (if needed)

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create database migration** (optional, table created on first use):
   ```bash
   npm run migrate:create
   ```
   Then add the org_credits schema from Feature 2 section above.

3. **Update app.ts** to use the new middleware:
   ```typescript
   import { tenantContextMiddleware } from './middleware/tenantContext.js'
   import { costMeterMiddleware } from './middleware/costMeter.js'
   
   app.use(tenantContextMiddleware)
   app.use(costMeterMiddleware)
   ```

4. **Run tests to verify**:
   ```bash
   npm test
   ```

---

## Troubleshooting

**Tests won't run (vitest not found)**:
- Run `npm install` to ensure dependencies are installed

**costMeter tests fail (Postgres error)**:
- Ensure testcontainers Docker daemon is running
- Check that port 5432 is available

**tenantId not in logs**:
- Ensure tenantContextMiddleware runs before logger usage
- Check that tracingContext is properly initialized in app startup

**Tenant validation failing unexpectedly**:
- Use `isValidTenantId()` to check format before setting
- Remember tenant IDs are case-insensitive (normalized to lowercase)
- Check max length (255 chars)

---

## Next Steps

Consider these enhancements:

1. **Pagination**: Add encoded cursor support to API routes
2. **Cost Meter**: Add Redis-based rate limiting for high concurrency
3. **Tenant Context**: Add tenant quotas and tier enforcement
4. **Logging**: Add tenant ID to request correlation IDs
5. **Monitoring**: Add metrics for tenant usage and cost breakdown

---

For detailed implementation information, see `IMPLEMENTATION_SUMMARY.md`.
