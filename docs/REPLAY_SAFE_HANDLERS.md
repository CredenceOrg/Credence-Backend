# Replay-Safe Handlers & Side-Effects

> **Testing note:** Boundary and recovery coverage for `src/lib/replaySafe.ts` lives in
> `src/lib/__tests__/replaySafe.test.ts`. The invariants documented below are asserted
> directly by those tests; treat this section as the contract they encode.

This document details the replay-safety mechanism in the Credence Backend. This architecture ensures that side-effects (e.g., sending webhooks, email notifications, external API integration) are handled correctly when failed inbound events are replayed or retried.

---

## 1. Problem Statement

In an at-least-once message processing system, failed events are captured and replayed (either automatically by queues or manually by operators via the Admin API/Ledger Replays).

When an event handler is replayed:
1. **Idempotent Actions** (such as database upserts or local cache updates) are safe to re-execute.
2. **Effectful Actions** (such as charging a customer, notifying downstream systems, or sending external notifications) should **not** run more than once. Re-running them causes unwanted duplicate side-effects.

---

## 2. Replay-Safety Architecture

To address this, the system introduces a context-aware wrapper that differentiates between:
- **First Attempt Execution**: The handler is executing for the first time. All side-effects must execute.
- **Retry/Replay Execution**: The handler is executing in response to a replay. Only side-effects explicitly marked as `replaySafe` should execute.

The context is tracked using Node's `AsyncLocalStorage` so that the execution path doesn't require passing context parameters down the call stack.

```
                    ┌─────────────────────────┐
                    │ Handler Execution Path  │
                    └─────────────────────────┘
                                 │
                                 ▼
                     Is this a Retry/Replay?
                       /                 \
                     YES                  NO
                     /                     \
        ┌─────────────────────────┐   ┌─────────────────────────┐
        │ Only execute side-      │   │ Execute all side-       │
        │ effects marked as       │   │ effects (safe & unsafe) │
        │ replay-safe             │   └─────────────────────────┘
        └─────────────────────────┘
```

---

## 3. API Reference

The core implementation lives in `src/lib/replaySafe.ts`.

### `replaySafeHandler(handler)`

A higher-order function/wrapper used to wrap event handlers registered with the `ReplayService`. It ensures that when the handler is executed by the replay system, a retry context is established.

```typescript
import { replaySafeHandler } from '../lib/replaySafe.js';

// Registers wrapped handler:
replayService.registerHandler('my_event', replaySafeHandler(new MyReplayHandler()));
```

### `runSideEffect(name, fn, options)`

Wraps a side-effect block. In a retry/replay context, the function `fn` is executed **only** if `options.replaySafe` is set to `true`. Otherwise, it is skipped.

- **`name`** (`string`): A descriptor for the side-effect (used for logging).
- **`fn`** (`() => Promise<T>`): The asynchronous operation to perform.
- **`options.replaySafe`** (`boolean`): If `true`, the side-effect executes on retry/replay. Defaults to `false`.

The return value is the resolved value of `fn` when it runs, and `undefined` when the
side-effect is skipped. Callers must not assume a value is present; branch on the
result only when the side-effect is known to be `replaySafe`.

---

## 4. Usage Example

```typescript
import { runSideEffect } from '../lib/replaySafe.js';

export class WithdrawalReplayHandler implements ReplayHandler {
  async handle(eventData: any): Promise<void> {
    // 1. Safe DB operation (runs on first attempt AND retry)
    await this.db.bonds.update(eventData);

    // 2. Non-replay-safe side-effect (skipped on retry)
    await runSideEffect('send-slack-alert', async () => {
      await slackClient.send(`Withdrawal processed: ${eventData.id}`);
    }, { replaySafe: false }); // Defaults to false

    // 3. Replay-safe side-effect (runs on first attempt AND retry)
    await runSideEffect('emit-metric', async () => {
      await metrics.counter('withdrawal_retry_attempt').inc();
    }, { replaySafe: true });
  }
}
```

---

## 5. Invariants

These invariants are enforced by `src/lib/replaySafe.ts` and must hold for every
execution path. Any change that weakens them is a regression.

1. **Context isolation.** The retry/replay flag is stored in `AsyncLocalStorage`.
   It is scoped to the wrapped handler invocation and never leaks across
   concurrent handlers, across `await` boundaries outside the wrapper, or into
   unrelated async work.
2. **Default-deny for side-effects.** `runSideEffect` skips `fn` on replay unless
   `options.replaySafe === true`. Missing, `undefined`, or non-boolean truthy
   values do not opt a side-effect in.
3. **First-attempt completeness.** Outside a replay context, every `runSideEffect`
   call executes `fn` regardless of `replaySafe`.
4. **Error propagation.** If `fn` throws or rejects, the error propagates to the
   caller unchanged. A failed side-effect must not be silently swallowed, and it
   must not corrupt the surrounding replay context.
5. **Context restoration.** After `replaySafeHandler` returns or throws, the
   previous `AsyncLocalStorage` value is restored. Nested wrappers compose
   correctly and the innermost context wins for the duration of its scope.

---

## 6. Boundary and Recovery Behavior

The following cases are covered by focused tests. They describe the observable
behavior callers can rely on.

| Case | Input | Expected behavior |
| --- | --- | --- |
| First attempt | No replay context | All side-effects run, including `replaySafe: false`. |
| Replay, non-safe | Replay context, `replaySafe: false` | `fn` is skipped; `runSideEffect` resolves to `undefined`. |
| Replay, safe | Replay context, `replaySafe: true` | `fn` runs and its value is returned. |
| Duplicate replay | Replay context invoked twice | Each invocation is independent; no shared mutable state carries over. |
| Invalid `name` | Empty string or non-string | Rejected before `fn` runs; no side-effect executes. |
| Invalid `fn` | Not a function | Rejected before any context mutation; no side-effect executes. |
| `fn` rejects | Any context | Rejection propagates; context is still restored. |
| Concurrent handlers | Overlapping async invocations | Each sees only its own replay flag. |
| Nested wrappers | Wrapper inside wrapper | Innermost context applies; outer context restored on exit. |

### Recovery guarantees

- A thrown side-effect does not leave the replay context "stuck" in a replay
  state for subsequent work on the same async chain.
- Retrying a handler after a partial failure re-executes only the side-effects
  that are `replaySafe`; non-safe side-effects that already succeeded are not
  repeated.
- No user data is mutated by `runSideEffect` itself. It only gates execution, so
  a skipped side-effect cannot cause silent data loss in the caller's own
  persistence layer.

---

## 7. Observability

- Every skipped side-effect is logged with its `name` and the reason
  (`replay-context`). Logs never include the side-effect payload or any
  sensitive event data.
- Executed side-effects are logged with their `name` and outcome
  (`success` / `error`). Error logs include the error message but not the
  payload.
- Failures surface to the caller as thrown errors so the replay system can
  record the attempt and schedule a retry.

---

## 8. Compatibility

`replaySafeHandler` and `runSideEffect` keep their existing signatures. The
behavioral clarifications above (return value on skip, validation of `name` and
`fn`, context restoration on throw) are additive: existing callers that ignore
the return value and pass valid arguments are unaffected.
