/**
 * @module routes/governance
 * @description Express routes for the Credence arbitration log API.
 *
 * All endpoints live under `/api/governance/arbitration-logs`.
 *
 * | Method | Path                                | Description                      |
 * |--------|-------------------------------------|----------------------------------|
 * | POST   | `/disputes/:disputeId/open`         | Open a new dispute               |
 * | POST   | `/disputes/:disputeId/evidence`     | Submit evidence                  |
 * | POST   | `/disputes/:disputeId/vote`         | Cast an arbitrator vote          |
 * | POST   | `/disputes/:disputeId/resolve`      | Record dispute resolution        |
 * | POST   | `/disputes/:disputeId/escalate`     | Escalate a dispute               |
 * | GET    | `/disputes/:disputeId/timeline`     | Full timeline for a dispute      |
 * | GET    | `/entries/:id`                      | Single entry by ID               |
 * | GET    | `/entries`                          | Query with filters               |
 */

import { Router, type Request, type Response } from 'express';

import { ArbitrationLogService } from '../services/governance/arbitrationLogs.js';
import type {
  DisputeOpenedPayload,
  EvidenceSubmittedPayload,
  VoteCastPayload,
  DisputeResolvedPayload,
  DisputeEscalatedPayload,
  ArbitrationEventType,
  ArbitrationLogQuery,
} from '../types/governance.js';

/**
 * Create and return an Express {@link Router} wired to the given
 * {@link ArbitrationLogService}.
 *
 * @param service - The service instance to delegate to.
 * @returns Configured Express router.
 */
export function createGovernanceRouter(
  service: ArbitrationLogService,
): Router {
  const router = Router();

  // -----------------------------------------------------------------------
  // Write endpoints
  // -----------------------------------------------------------------------

  /** Open a new dispute. */
  router.post(
    '/disputes/:disputeId/open',
    (req: Request, res: Response): void => {
      const { disputeId } = req.params;
      const { claimant, respondent, reason, evidenceRefs } =
        req.body as DisputeOpenedPayload & { actor?: string };
      const actor = (req.body as { actor?: string }).actor ?? claimant;

      const entry = service.logDisputeOpened(
        disputeId,
        { claimant, respondent, reason, evidenceRefs },
        actor,
      );
      res.status(201).json(entry);
    },
  );

  /** Submit evidence to an existing dispute. */
  router.post(
    '/disputes/:disputeId/evidence',
    (req: Request, res: Response): void => {
      const { disputeId } = req.params;
      const { submittedBy, evidenceRefs } =
        req.body as EvidenceSubmittedPayload;
      const actor =
        (req.body as { actor?: string }).actor ?? submittedBy;

      const entry = service.logEvidenceSubmitted(
        disputeId,
        { submittedBy, evidenceRefs },
        actor,
      );
      res.status(201).json(entry);
    },
  );

  /** Cast an arbitrator vote. */
  router.post(
    '/disputes/:disputeId/vote',
    (req: Request, res: Response): void => {
      const { disputeId } = req.params;
      const { voter, direction, justification } =
        req.body as VoteCastPayload;
      const actor = (req.body as { actor?: string }).actor ?? voter;

      const entry = service.logVoteCast(
        disputeId,
        { voter, direction, justification },
        actor,
      );
      res.status(201).json(entry);
    },
  );

  /** Record dispute resolution. */
  router.post(
    '/disputes/:disputeId/resolve',
    (req: Request, res: Response): void => {
      const { disputeId } = req.params;
      const { outcome, summary, voteTally } =
        req.body as DisputeResolvedPayload;
      const actor = (req.body as { actor: string }).actor;

      const entry = service.logDisputeResolved(
        disputeId,
        { outcome, summary, voteTally },
        actor,
      );
      res.status(201).json(entry);
    },
  );

  /** Escalate a dispute. */
  router.post(
    '/disputes/:disputeId/escalate',
    (req: Request, res: Response): void => {
      const { disputeId } = req.params;
      const { reason, escalatedTo } =
        req.body as DisputeEscalatedPayload;
      const actor = (req.body as { actor: string }).actor;

      const entry = service.logDisputeEscalated(
        disputeId,
        { reason, escalatedTo },
        actor,
      );
      res.status(201).json(entry);
    },
  );

  // -----------------------------------------------------------------------
  // Read endpoints
  // -----------------------------------------------------------------------

  /** Full timeline for a dispute (ordered by sequence number). */
  router.get(
    '/disputes/:disputeId/timeline',
    (req: Request, res: Response): void => {
      const { disputeId } = req.params;
      const timeline = service.getDisputeTimeline(disputeId);
      res.json(timeline);
    },
  );

  /** Retrieve a single log entry by its ID. */
  router.get('/entries/:id', (req: Request, res: Response): void => {
    const entry = service.getEntryById(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json(entry);
  });

  /**
   * Query log entries with optional filters.
   *
   * Query-string parameters: `disputeId`, `identity`, `eventTypes`
   * (comma-separated), `from`, `to`, `limit`, `offset`.
   */
  router.get('/entries', (req: Request, res: Response): void => {
    const q: ArbitrationLogQuery = {};
    if (req.query.disputeId) q.disputeId = req.query.disputeId as string;
    if (req.query.identity) q.identity = req.query.identity as string;
    if (req.query.eventTypes) {
      const rawEventTypes = (req.query.eventTypes as string).split(',');
      const sanitizedEventTypes = rawEventTypes
        .map((v) => v.trim())
        .filter((v) => v.length > 0) as ArbitrationEventType[];
      if (sanitizedEventTypes.length > 0) {
        q.eventTypes = sanitizedEventTypes;
      }
    }
    if (req.query.from) q.from = req.query.from as string;
    if (req.query.to) q.to = req.query.to as string;
    if (req.query.limit !== undefined) {
      const limit = Number.parseInt(req.query.limit as string, 10);
      if (Number.isNaN(limit) || limit < 0) {
        res.status(400).json({ error: 'Invalid "limit" query parameter' });
        return;
      }
      q.limit = limit;
    }
    if (req.query.offset !== undefined) {
      const offset = Number.parseInt(req.query.offset as string, 10);
      if (Number.isNaN(offset) || offset < 0) {
        res.status(400).json({ error: 'Invalid "offset" query parameter' });
        return;
      }
      q.offset = offset;
    }

    const entries = service.query(q);
    res.json(entries);
  });

  return router;
}
