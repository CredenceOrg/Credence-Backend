/**
 * @file Tests for governance API routes.
 *
 * Uses a lightweight Express test approach: import the router, mount it,
 * and call endpoints via the service interface to verify serialisation.
 *
 * Covers:
 * - POST /disputes/:disputeId/open
 * - POST /disputes/:disputeId/evidence
 * - POST /disputes/:disputeId/vote
 * - POST /disputes/:disputeId/resolve
 * - POST /disputes/:disputeId/escalate
 * - GET  /disputes/:disputeId/timeline
 * - GET  /entries/:id
 * - GET  /entries (query filters)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';

import { ArbitrationLogService } from '../../src/services/governance/arbitrationLogs.js';
import { createGovernanceRouter } from '../../src/routes/governance.js';
import {
  ArbitrationEventType,
  DisputeOutcome,
  VoteDirection,
} from '../../src/types/governance.js';

// ---------------------------------------------------------------------------
// Helpers – lightweight request helper (no supertest dependency)
// ---------------------------------------------------------------------------

/**
 * Tiny helper that sends an HTTP request to an Express app and returns
 * the status code + parsed JSON body.
 */
async function request(
  app: Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not get server address'));
        return;
      }

      const url = `http://127.0.0.1:${addr.port}${path}`;
      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body) options.body = JSON.stringify(body);

      fetch(url, options)
        .then(async (res) => {
          const json = await res.json();
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Governance Routes', () => {
  let app: Express;
  let service: ArbitrationLogService;
  const BASE = '/api/governance/arbitration-logs';

  beforeEach(() => {
    service = new ArbitrationLogService();
    app = express();
    app.use(express.json());
    app.use(BASE, createGovernanceRouter(service));
  });

  // -- POST open -----------------------------------------------------------

  describe('POST /disputes/:disputeId/open', () => {
    it('should create a dispute and return 201', async () => {
      const { status, body } = await request(
        app,
        'POST',
        `${BASE}/disputes/d1/open`,
        {
          claimant: '0xAAA',
          respondent: '0xBBB',
          reason: 'False claim',
        },
      );

      expect(status).toBe(201);
      const entry = body as Record<string, unknown>;
      expect(entry.disputeId).toBe('d1');
      expect(entry.eventType).toBe(ArbitrationEventType.DISPUTE_OPENED);
    });
  });

  // -- POST evidence -------------------------------------------------------

  describe('POST /disputes/:disputeId/evidence', () => {
    it('should record evidence and return 201', async () => {
      // Open first
      await request(app, 'POST', `${BASE}/disputes/d1/open`, {
        claimant: '0xAAA',
        respondent: '0xBBB',
        reason: 'Test',
      });

      const { status, body } = await request(
        app,
        'POST',
        `${BASE}/disputes/d1/evidence`,
        {
          submittedBy: '0xBBB',
          evidenceRefs: [{ label: 'doc', uri: 'ipfs://Qm1' }],
        },
      );

      expect(status).toBe(201);
      expect((body as Record<string, unknown>).eventType).toBe(
        ArbitrationEventType.EVIDENCE_SUBMITTED,
      );
    });
  });

  // -- POST vote -----------------------------------------------------------

  describe('POST /disputes/:disputeId/vote', () => {
    it('should record a vote and return 201', async () => {
      await request(app, 'POST', `${BASE}/disputes/d1/open`, {
        claimant: '0xAAA',
        respondent: '0xBBB',
        reason: 'Test',
      });

      const { status, body } = await request(
        app,
        'POST',
        `${BASE}/disputes/d1/vote`,
        {
          voter: '0xArb',
          direction: VoteDirection.FOR_CLAIMANT,
          justification: 'Solid proof',
        },
      );

      expect(status).toBe(201);
      expect((body as Record<string, unknown>).eventType).toBe(
        ArbitrationEventType.VOTE_CAST,
      );
    });
  });

  // -- POST resolve --------------------------------------------------------

  describe('POST /disputes/:disputeId/resolve', () => {
    it('should record resolution and return 201', async () => {
      await request(app, 'POST', `${BASE}/disputes/d1/open`, {
        claimant: '0xAAA',
        respondent: '0xBBB',
        reason: 'Test',
      });

      const { status, body } = await request(
        app,
        'POST',
        `${BASE}/disputes/d1/resolve`,
        {
          outcome: DisputeOutcome.CLAIMANT_WINS,
          summary: 'Decided in favour of claimant',
          actor: '0xPanel',
        },
      );

      expect(status).toBe(201);
      expect((body as Record<string, unknown>).eventType).toBe(
        ArbitrationEventType.DISPUTE_RESOLVED,
      );
    });
  });

  // -- POST escalate -------------------------------------------------------

  describe('POST /disputes/:disputeId/escalate', () => {
    it('should record escalation and return 201', async () => {
      await request(app, 'POST', `${BASE}/disputes/d1/open`, {
        claimant: '0xAAA',
        respondent: '0xBBB',
        reason: 'Test',
      });

      const { status, body } = await request(
        app,
        'POST',
        `${BASE}/disputes/d1/escalate`,
        {
          reason: 'Tie vote',
          escalatedTo: '0xHigherPanel',
          actor: '0xAAA',
        },
      );

      expect(status).toBe(201);
      expect((body as Record<string, unknown>).eventType).toBe(
        ArbitrationEventType.DISPUTE_ESCALATED,
      );
    });
  });

  // -- GET timeline --------------------------------------------------------

  describe('GET /disputes/:disputeId/timeline', () => {
    it('should return full timeline in sequence order', async () => {
      // Seed a small lifecycle
      await request(app, 'POST', `${BASE}/disputes/d1/open`, {
        claimant: '0xAAA',
        respondent: '0xBBB',
        reason: 'Test',
      });
      await request(app, 'POST', `${BASE}/disputes/d1/vote`, {
        voter: '0xArb',
        direction: VoteDirection.FOR_CLAIMANT,
      });

      const { status, body } = await request(
        app,
        'GET',
        `${BASE}/disputes/d1/timeline`,
      );

      expect(status).toBe(200);
      const entries = body as unknown[];
      expect(entries).toHaveLength(2);
    });

    it('should return empty array for unknown dispute', async () => {
      const { status, body } = await request(
        app,
        'GET',
        `${BASE}/disputes/unknown/timeline`,
      );
      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  // -- GET entries/:id -----------------------------------------------------

  describe('GET /entries/:id', () => {
    it('should return an entry by id', async () => {
      const { body: created } = await request(
        app,
        'POST',
        `${BASE}/disputes/d1/open`,
        {
          claimant: '0xAAA',
          respondent: '0xBBB',
          reason: 'Test',
        },
      );

      const id = (created as Record<string, string>).id;
      const { status, body } = await request(
        app,
        'GET',
        `${BASE}/entries/${id}`,
      );

      expect(status).toBe(200);
      expect((body as Record<string, unknown>).id).toBe(id);
    });

    it('should return 404 for unknown id', async () => {
      const { status } = await request(
        app,
        'GET',
        `${BASE}/entries/nonexistent`,
      );
      expect(status).toBe(404);
    });
  });

  // -- GET entries (query) -------------------------------------------------

  describe('GET /entries', () => {
    it('should return all entries when no filter is given', async () => {
      await request(app, 'POST', `${BASE}/disputes/d1/open`, {
        claimant: '0xAAA',
        respondent: '0xBBB',
        reason: 'Test',
      });
      await request(app, 'POST', `${BASE}/disputes/d2/open`, {
        claimant: '0xCCC',
        respondent: '0xDDD',
        reason: 'Other test',
      });

      const { status, body } = await request(
        app,
        'GET',
        `${BASE}/entries`,
      );

      expect(status).toBe(200);
      expect(body).toHaveLength(2);
    });

    it('should filter by disputeId', async () => {
      await request(app, 'POST', `${BASE}/disputes/d1/open`, {
        claimant: '0xAAA',
        respondent: '0xBBB',
        reason: 'Test',
      });
      await request(app, 'POST', `${BASE}/disputes/d2/open`, {
        claimant: '0xCCC',
        respondent: '0xDDD',
        reason: 'Other test',
      });

      const { body } = await request(
        app,
        'GET',
        `${BASE}/entries?disputeId=d1`,
      );
      expect(body).toHaveLength(1);
    });

    it('should filter by eventTypes (comma-separated)', async () => {
      await request(app, 'POST', `${BASE}/disputes/d1/open`, {
        claimant: '0xAAA',
        respondent: '0xBBB',
        reason: 'Test',
      });
      await request(app, 'POST', `${BASE}/disputes/d1/vote`, {
        voter: '0xArb',
        direction: VoteDirection.FOR_CLAIMANT,
      });

      const { body } = await request(
        app,
        'GET',
        `${BASE}/entries?eventTypes=VOTE_CAST`,
      );
      expect(body).toHaveLength(1);
    });

    it('should support limit and offset', async () => {
      await request(app, 'POST', `${BASE}/disputes/d1/open`, {
        claimant: '0xAAA',
        respondent: '0xBBB',
        reason: 'A',
      });
      await request(app, 'POST', `${BASE}/disputes/d2/open`, {
        claimant: '0xCCC',
        respondent: '0xDDD',
        reason: 'B',
      });
      await request(app, 'POST', `${BASE}/disputes/d3/open`, {
        claimant: '0xEEE',
        respondent: '0xFFF',
        reason: 'C',
      });

      const { body } = await request(
        app,
        'GET',
        `${BASE}/entries?limit=2&offset=1`,
      );
      expect(body).toHaveLength(2);
    });
  });
});
