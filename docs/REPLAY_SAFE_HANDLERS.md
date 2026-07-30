# Replay-Safe Handlers & Side-Effects

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
