# feat(shutdown): drain in-flight requests, close DB pools, and exit cleanly on SIGTERM

## Description

This PR fixes a bug where `SIGTERM` and `SIGINT` signals bypassed the configured `GracefulShutdownManager` in production (due to duplicate signal handlers in `src/index.ts` that immediately called `process.exit(0)` when the HTTP server closed, bypassing the closing of DB pools, Redis connections, and background schedulers).

With this fix, signals are correctly routed to the `GracefulShutdownManager`, which performs a clean, ordered graceful shutdown sequence before exiting.

Closes #<this-issue>

## Changes

- **`src/index.ts`**: Removed duplicate local `shutdown` handler and its signal registrations to ensure `GracefulShutdownManager` manages the shutdown process.
- **`src/__tests__/gracefulShutdown.test.ts`**: Added a new sequence verification test to ensure that the server closing/draining, database pools closing, and process exiting occur in the correct order.
- **`README.md`**: Documented the graceful shutdown behavior.
- **`docs/graceful-shutdown.md`**: Updated signal handling architecture notes.

## Commits

1. `fix(shutdown): remove redundant signal handlers in index.ts`
2. `test(shutdown): add test to verify shutdown sequence order`
3. `docs(shutdown): document production graceful shutdown and signal handling`

## Checklist

- [x] The change matches the summary above.
- [x] No regression in the existing test suite.
- [x] The change is documented where it is observable (README, docs/).
- [x] Lint, type-check, and tests all pass locally.
- [x] PR description references this issue with `Closes #<this-issue>`.
