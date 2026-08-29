import { Request, Response, NextFunction } from 'express';
import { runWithGlobalTimeout } from '../utils/timeoutContext.js';

export function createTimeoutBudgetMiddleware(globalTimeoutMs: number) {
  return function timeoutBudgetMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Optionally allow clients to specify a stricter timeout, but cap it at the global configuration
    const headerTimeout = req.headers['x-timeout-ms'];
    let requestTimeout = globalTimeoutMs;

    if (typeof headerTimeout === 'string') {
      const parsed = parseInt(headerTimeout, 10);
      if (!isNaN(parsed) && parsed > 0) {
        requestTimeout = Math.min(parsed, globalTimeoutMs);
      }
    }

    runWithGlobalTimeout(requestTimeout, next);
  };
}
