import { AsyncLocalStorage } from 'node:async_hooks'
import { DEFAULT_REPLAY_SAFE } from '../config/constants.js'

export interface ReplayHandler {
  handle(eventData: any): Promise<void>
}

export interface ReplayContext {
  isRetry: boolean
}

export const replayContext = new AsyncLocalStorage<ReplayContext>()

/**
 * Runs a function within a retry context.
 *
 * Invariants:
 * - The context is propagated across async boundaries via AsyncLocalStorage.
 * - Nested retry contexts remain retry contexts (idempotent).
 * - The context is always cleaned up after the callback settles,
 *   even if it throws or rejects.
 */
export function runInRetryContext<T>(fn: () => Promise<T>): Promise<T> {
  return replayContext.run({ isRetry: true }, fn)
}

/**
 * Returns true if the current execution is within a retry/replay context.
 */
export function isRetry(): boolean {
  return replayContext.getStore()?.isRetry ?? false
}

/**
 * Wraps a handler function or a ReplayHandler object to execute within a retry context.
 *
 * The wrapped callable preserves the original return value and rejection reason,
 * and always exits the retry context after the handler settles.
 */
export function replaySafeHandler(
  handler: ReplayHandler | ((eventData: any) => Promise<any>)
): any {
  if (typeof handler === 'function') {
    return async (eventData: any) => {
      return await runInRetryContext(async () => {
        return await handler(eventData)
      })
    }
  }

  return {
    handle: async (eventData: any) => {
      return await runInRetryContext(async () => {
        return await handler.handle(eventData)
      })
    }
  }
}

export interface SideEffectOptions {
  replaySafe?: boolean
}

/**
 * Executes a side-effect function. If currently in a retry context, the side-effect
 * will only execute if `options.replaySafe` is explicitly set to true. Otherwise,
 * it is skipped and returns `undefined`.
 *
 * Invariants:
 * - When not in a retry context, the side-effect always runs.
 * - When in a retry context and `replaySafe` is false, the side-effect is skipped
 *   and `undefined` is returned without invoking `fn`; errors from `fn` cannot
 *   observe this path.
 * - When in a retry context and `replaySafe` is true, the side-effect runs and
 *   its result or rejection reason is propagated to the caller.
 * - Skipped side-effects are logged with the name only; event data is never logged.
 */
export async function runSideEffect<T>(
  name: string,
  fn: () => Promise<T>,
  options: SideEffectOptions = {}
): Promise<T | undefined> {
  const isCurrentlyRetry = isRetry()
  const replaySafe = options.replaySafe ?? DEFAULT_REPLAY_SAFE

  if (isCurrentlyRetry && !replaySafe) {
    console.log(`[ReplaySafe] Skipping non-replay-safe side-effect on retry: ${name}`)
    return undefined
  }

  return await fn()
}
