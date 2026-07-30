/**
 * Audit logging middleware
 *
 * Wires up request-scoped audit-log buffering so that every admin action
 * during a single request is coalesced into a single batch write rather than
 * written individually. This reduces I/O when the audit backend is a remote
 * database.
 *
 * Usage (in app.ts or a router):
 *   app.use(auditBufferMiddleware);
 */

import type { Request, Response, NextFunction } from 'express';
import { auditLogService } from '../services/audit/index.js';

/**
 * Express middleware that:
 * 1. Starts an audit-log buffer at the beginning of every request.
 * 2. Flushes the buffer after the response is sent (on `finish`).
 * 3. Discards the buffer if the response status >= 500 (server error paths
 *    should not commit partial audit trails).
 *
 * Only admin endpoints need buffering, but the overhead of starting/stopping
 * a buffer is negligible, so it is safe to apply globally.
 */
export function auditBufferMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  auditLogService.startBuffer();

  res.on('finish', () => {
    if (res.statusCode >= 500) {
      // Server error — discard the partial buffer since the action may not
      // have completed reliably.
      auditLogService.discardBuffer();
    } else {
      auditLogService.flush();
    }
  });

  next();
}
