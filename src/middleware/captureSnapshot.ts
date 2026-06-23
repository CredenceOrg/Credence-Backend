// Middleware to capture snapshots of identity and bond tables when X-Capture-Snapshot header is set
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { RequestSnapshotsRepository } from '../db/repositories/requestSnapshotsRepository.js';
import { pool } from '../db/pool.js';
import { IdentityRepository } from '../db/repositories/identityRepository.js';
import { BondsRepository } from '../db/repositories/bondsRepository.js';
import { requireAdminRole, AuthenticatedRequest } from './auth.js';
import { redactLegacy } from '../observability/redaction.js';

export async function captureSnapshot(req: Request, res: Response, next: NextFunction) {
  if (req.header('X-Capture-Snapshot') !== '1') {
    return next();
  }

  // Require admin role to trigger snapshots
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'User authentication required to capture snapshots',
    });
    return;
  }

  if (
    authReq.user.role !== 'admin' &&
    authReq.user.role !== 'super-admin'
  ) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin role required to capture snapshots',
    });
    return;
  }

  const requestId = uuidv4();
  // Attach requestId for downstream if needed
  (req as any).snapshotRequestId = requestId;

  // After response finishes, capture DB state
  res.on('finish', async () => {
    const client = await pool.connect();
    try {
      const identityRepo = new IdentityRepository(client);
      const bondsRepo = new BondsRepository(client);
      const identities = await identityRepo.findAll(); // assume method exists
      const bonds = await bondsRepo.findAll(); // assume method exists
      const snapshot = { identities, bonds };

      // Redact sensitive fields from headers and body before storing
      const redactedHeaders = redactLegacy(req.headers);
      const redactedBody = redactLegacy(req.body);

      const repo = new RequestSnapshotsRepository(client);
      await repo.create({
        requestId,
        method: req.method,
        path: req.originalUrl,
        headers: redactedHeaders as any,
        body: redactedBody,
        snapshot,
      });
    } catch (e) {
      console.error('Failed to capture snapshot', e);
    } finally {
      client.release();
    }
  });
  next();
}
