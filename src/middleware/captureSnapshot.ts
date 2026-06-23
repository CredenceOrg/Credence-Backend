// Middleware to capture snapshots of identity and bond tables when X-Capture-Snapshot header is set
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { RequestSnapshotsRepository } from '../db/repositories/requestSnapshotsRepository.js';
import { pool } from '../db/pool.js';
import { IdentityRepository } from '../db/repositories/identityRepository.js';
import { BondsRepository } from '../db/repositories/bondsRepository.js';

export async function captureSnapshot(req: Request, res: Response, next: NextFunction) {
  if (req.header('X-Capture-Snapshot') !== '1') {
    return next();
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
      const repo = new RequestSnapshotsRepository(client);
      await repo.create({
        requestId,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers as any,
        body: req.body,
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
