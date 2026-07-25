# Pull Request Description

## Overview
This PR implements request-scoped logging context (`req.log`) on Express request objects. Route handlers and middlewares can now call `req.log.info()`, `req.log.warn()`, `req.log.error()`, or `req.log.debug()` to emit structured logs with the correct request metadata (`requestId`, `correlationId`, `route`, `tenant`, and `actor`) automatically populated. This resolves workarounds where context was lost during event loop execution.

## Key Additions & Changes
1. **Request Logger Types & Helpers** (`src/types/express.d.ts`, `src/utils/logger.ts`):
   - Augment Express `Request` type definition to expose the `log: RequestLogger` property.
   - Implement `createRequestLogger` in `logger.ts` to format logs with a custom/explicit context `Map`.
   - Update `logger` methods (`info`, `warn`, `error`, `debug`) to accept `redactionContext` parameters.

2. **Middleware Attachment** (`src/middleware/requestId.ts`):
   - Instantiate and bind `req.log` to a Proxy wrapper over the request tracing context.
   - The Proxy implements dynamic fallback lookup for `tenant` and `actor` IDs from the request header/user properties, allowing downstream auth middlewares to cleanly update the logging context.

3. **ESLint Plugin Update** (`src/observability/eslint-plugin-logger-schema.ts`):
   - Modified the custom ESLint rules to parse and validate both `logger.x()` and `req.log.x()` expressions. This ensures that `req.log` calls conform to the allowlist PII schema validations.

4. **Documentation**:
   - Updated `README.md`, `docs/LOGGING.md`, and `docs/observability.md` to document the new `req.log` logger, including example usages.

5. **Tests**:
   - Added `src/middleware/__tests__/requestLogger.test.ts` to test request context binding, dynamic updating of tenant/actor context, and deferred logging outside request lifecycles.

Closes #866
