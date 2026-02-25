/**
 * @module services/governance/voteService
 * @description Service for casting and tallying arbitrator votes on disputes.
 *
 * Rules:
 * - Each voter may only vote once per dispute.
 * - The dispute must be in VOTING status to accept votes.
 * - `computeTally` returns an aggregated count and `hasMet` indicates
 *   whether the configured threshold has been reached.
 */

import { randomUUID } from 'node:crypto';

import type { Vote, VoteTally } from '../../types/governance.js';
import { VoteDirection } from '../../types/governance.js';

// ── Service ───────────────────────────────────────────────────────────────

/**
 * In-memory vote management service.
 *
 * @example
 * ```ts
 * const svc = new VoteService();
 * svc.cast({ disputeId: 'd-1', voter: '0xArb1', direction: VoteDirection.FOR_CLAIMANT });
 * const { tally, hasMet } = svc.computeTally('d-1', 2);
 * ```
 */
export class VoteService {
  private readonly votes: Vote[] = [];

  // ── Cast ──────────────────────────────────────────────────────────────

  /**
   * Cast a vote on a dispute.
   *
   * @param params - Vote details (disputeId, voter, direction, optional justification).
   * @returns The persisted vote.
   * @throws {Error} If the voter has already voted on this dispute or params are invalid.
   */
  cast(params: {
    disputeId: string;
    voter: string;
    direction: VoteDirection;
    justification?: string;
  }): Vote {
    if (!params.disputeId?.trim()) throw new Error('disputeId is required');
    if (!params.voter?.trim()) throw new Error('voter is required');
    if (!Object.values(VoteDirection).includes(params.direction)) {
      throw new Error(`Invalid vote direction: ${params.direction}`);
    }

    const existing = this.votes.find(
      (v) => v.disputeId === params.disputeId && v.voter === params.voter,
    );
    if (existing) {
      throw new Error(
        `Voter ${params.voter} has already voted on dispute ${params.disputeId}`,
      );
    }

    const vote: Vote = {
      id: randomUUID(),
      disputeId: params.disputeId,
      voter: params.voter,
      direction: params.direction,
      justification: params.justification,
      timestamp: new Date().toISOString(),
    };

    this.votes.push(vote);
    return { ...vote };
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /** Get all votes for a dispute. */
  getByDispute(disputeId: string): Vote[] {
    return this.votes
      .filter((v) => v.disputeId === disputeId)
      .map((v) => ({ ...v }));
  }

  /** Get all votes cast by a specific voter across disputes. */
  getByVoter(voter: string): Vote[] {
    return this.votes
      .filter((v) => v.voter === voter)
      .map((v) => ({ ...v }));
  }

  // ── Tally ─────────────────────────────────────────────────────────────

  /**
   * Compute the vote tally for a dispute and check whether the threshold
   * for a decision has been met.
   *
   * The threshold is considered met when the leading non-abstain direction
   * has at least `threshold` votes.
   *
   * @param disputeId - The dispute to tally.
   * @param threshold - Minimum votes needed for the leading direction.
   * @returns `{ tally, hasMet, leadingDirection }`.
   */
  computeTally(
    disputeId: string,
    threshold: number,
  ): {
    tally: VoteTally;
    hasMet: boolean;
    leadingDirection: VoteDirection | null;
  } {
    const dvotes = this.votes.filter((v) => v.disputeId === disputeId);

    const tally: VoteTally = {
      forClaimant: 0,
      forRespondent: 0,
      abstain: 0,
      total: dvotes.length,
    };

    for (const v of dvotes) {
      switch (v.direction) {
        case VoteDirection.FOR_CLAIMANT:
          tally.forClaimant++;
          break;
        case VoteDirection.FOR_RESPONDENT:
          tally.forRespondent++;
          break;
        case VoteDirection.ABSTAIN:
          tally.abstain++;
          break;
      }
    }

    let leadingDirection: VoteDirection | null = null;
    const leading = Math.max(tally.forClaimant, tally.forRespondent);

    if (leading > 0) {
      leadingDirection =
        tally.forClaimant >= tally.forRespondent
          ? VoteDirection.FOR_CLAIMANT
          : VoteDirection.FOR_RESPONDENT;
    }

    return {
      tally,
      hasMet: leading >= threshold,
      leadingDirection,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Total number of votes in the store. */
  get size(): number {
    return this.votes.length;
  }

  /** Reset (testing only). */
  clear(): void {
    this.votes.length = 0;
  }
}
