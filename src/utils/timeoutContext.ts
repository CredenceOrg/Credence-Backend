import { AsyncLocalStorage } from "node:async_hooks";

export const timeoutContext = new AsyncLocalStorage<number>();

/**
 * Run a function with a global timeout budget.
 * 
 * @param timeoutMs The total timeout budget for this request in milliseconds.
 * @param fn The function to run within the timeout context.
 * @returns The result of the function.
 */
export function runWithGlobalTimeout<T>(timeoutMs: number, fn: () => T): T {
  const deadline = Date.now() + timeoutMs;
  return timeoutContext.run(deadline, fn);
}

/**
 * Get the remaining global timeout budget in milliseconds.
 * 
 * @returns The remaining time in milliseconds, or undefined if no global timeout is set.
 */
export function getRemainingTimeoutMs(): number | undefined {
  const deadline = timeoutContext.getStore();
  if (deadline === undefined) {
    return undefined;
  }
  
  return Math.max(0, deadline - Date.now());
}
