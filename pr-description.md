# feat(replay): add replay-safe wrapper around effectful handlers

## Description

This PR implements a context-aware replay-safety mechanism in the Credence Backend. This ensures that effectful event handlers (e.g. sending webhooks, notification emails, external API integration) do not run duplicate side-effects when failed inbound events are replayed or retried.

Only side-effects explicitly marked as `replaySafe` will be executed during replay/retry runs, while others are safely skipped.

Closes #

## Changes

- **`src/lib/replaySafe.ts`**: Core utility implementing the `replayContext` (`AsyncLocalStorage`), the `replaySafeHandler` wrapper (supporting both function and object-based handlers), and the `runSideEffect` helper.
- **`src/lib/replaySafe.test.ts`**: Unit tests verifying the retry context isolation, the behavior of `runSideEffect` under normal vs retry conditions, and default fallback settings.
- **`src/config/constants.ts`**: Added central `DEFAULT_REPLAY_SAFE` constant.
- **`src/services/replayHandlers.ts`**: Integrated the `replaySafeHandler` wrapper in `registerAllReplayHandlers` to automatically enforce the retry context for all registered replay handlers.
- **`docs/REPLAY_SAFE_HANDLERS.md`**: Created a detailed architecture and API usage guide.
- **`README.md`**: Updated documentation references.

## Checklist

- [x] The change matches the summary above.
- [x] No regression in the existing test suite.
- [x] The change is documented where it is observable (README, docs/).
- [x] Lint, type-check, and tests all pass locally.
- [x] PR description references this issue with `Closes #`.
