/**
 * @module services/governance/disputeService
 * @description Service for creating, validating, and managing governance disputes.
 *
 * Disputes follow a lifecycle:
 *   OPEN → EVIDENCE → VOTING → RESOLVED / EXPIRED / ESCALATED
 *
 * Validation rules:
 * - claimant and respondent must be non-empty and distinct
 * - reason must be non-empty
 * - deadline must be a valid future ISO-8601 date at creation time
 * - status transitions are strictly enforced
 */

import { randomUUID } from 'node:crypto';

import type {
  Dispute,
  CreateDisputeParams,
  EvidenceRef,
} from '../../types/governance.js';
import { DisputeStatus, DisputeOutcome } from '../../types/governance.js';

// ── Valid transitions ─────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  [DisputeStatus.OPEN]: [DisputeStatus.EVIDENCE, DisputeStatus.EXPIRED, DisputeStatus.ESCALATED],
  [DisputeStatus.EVIDENCE]: [DisputeStatus.VOTING, DisputeStatus.EXPIRED, DisputeStatus.ESCALATED],
  [DisputeStatus.VOTING]: [DisputeStatus.RESOLVED, DisputeStatus.ESCALATED],
  [DisputeStatus.RESOLVED]: [],
  [DisputeStatus.EXPIRED]: [],
  [DisputeStatus.ESCALATED]: [DisputeStatus.VOTING, DisputeStatus.RESOLVED],
};

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_DEADLINE_DAYS = 7;

/** Produce a deadline N days from now. */
function defaultDeadline(days = DEFAULT_DEADLINE_DAYS): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ── Service ───────────────────────────────────────────────────────────────

/**
 * In-memory dispute management service.
 *
 * @example
 * ```ts
 * const svc = new DisputeService();
 * const dispute = svc.create({ claimant: '0xA', respondent: '0xB', reason: 'fraud' });
 * svc.transitionStatus(dispute.id, DisputeStatus.EVIDENCE);
 * ```
 */
export class DisputeService {
  private readonly disputes = new Map<string, Dispute>();

  // ── Create ────────────────────────────────────────────────────────────

  /**
   * Create and persist a new dispute.
   *
   * @throws {Error} Validation failures (empty fields, same parties, past deadline).
   */
  create(params: CreateDisputeParams): Dispute {
    this.validateCreateParams(params);

    const now = new Date().toISOString();
    const dispute: Dispute = {
      id: randomUUID(),
      claimant: params.claimant,
      respondent: params.respondent,
      reason: params.reason,
      status: DisputeStatus.OPEN,
      evidenceRefs: params.evidenceRefs ?? [],
      deadline: params.deadline ?? defaultDeadline(),
      createdAt: now,
      updatedAt: now,
    };

    this.disputes.set(dispute.id, dispute);
    return { ...dispute };
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /** Find a dispute by its ID. */
  getById(id: string): Dispute | undefined {
    const d = this.disputes.get(id);
    return d ? { ...d } : undefined;
  }

  /** Return all disputes. */
  list(): Dispute[] {
    return [...this.disputes.values()].map((d) => ({ ...d }));
  }

  // ── Status transitions ────────────────────────────────────────────────

  /**
   * Transition a dispute to a new status.
   *
   * @returns The updated dispute.
   * @throws {Error} If the dispute is not found or the transition is invalid.
   */
  transitionStatus(id: string, newStatus: DisputeStatus): Dispute {
    const dispute = this.disputes.get(id);
    if (!dispute) throw new Error(`Dispute not found: ${id}`);

    const allowed = VALID_TRANSITIONS[dispute.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${dispute.status} → ${newStatus}`,
      );
    }

    dispute.status = newStatus;
    dispute.updatedAt = new Date().toISOString();
    return { ...dispute };
  }

  // ── Resolve ───────────────────────────────────────────────────────────

  /**
   * Resolve a dispute with an outcome.  The dispute must be in VOTING status.
   *
   * @throws {Error} If the dispute is not in VOTING status.
   */
  resolve(id: string, outcome: DisputeOutcome): Dispute {
    const dispute = this.disputes.get(id);
    if (!dispute) throw new Error(`Dispute not found: ${id}`);
    if (
      dispute.status !== DisputeStatus.VOTING &&
      dispute.status !== DisputeStatus.ESCALATED
    ) {
      throw new Error(`Cannot resolve dispute in ${dispute.status} status`);
    }

    dispute.status = DisputeStatus.RESOLVED;
    dispute.outcome = outcome;
    dispute.updatedAt = new Date().toISOString();
    return { ...dispute };
  }

  // ── Evidence ──────────────────────────────────────────────────────────

  /**
   * Add evidence references to a dispute. Dispute must be OPEN or EVIDENCE.
   *
   * @throws {Error} If the dispute is not in an evidence-accepting status.
   */
  addEvidence(id: string, refs: EvidenceRef[]): Dispute {
    const dispute = this.disputes.get(id);
    if (!dispute) throw new Error(`Dispute not found: ${id}`);

    if (
      dispute.status !== DisputeStatus.OPEN &&
      dispute.status !== DisputeStatus.EVIDENCE
    ) {
      throw new Error(`Cannot add evidence in ${dispute.status} status`);
    }

    dispute.evidenceRefs.push(...refs);
    dispute.updatedAt = new Date().toISOString();
    return { ...dispute };
  }

  // ── Deadline ──────────────────────────────────────────────────────────

  /**
   * Check whether a dispute has passed its deadline.
   *
   * @returns `true` if the current time is past the dispute deadline.
   * @throws {Error} If the dispute is not found.
   */
  isExpired(id: string): boolean {
    const dispute = this.disputes.get(id);
    if (!dispute) throw new Error(`Dispute not found: ${id}`);
    return new Date() > new Date(dispute.deadline);
  }

  /**
   * Expire all disputes that have passed their deadline and are still
   * in an expirable status (OPEN or EVIDENCE).
   *
   * @returns Array of dispute IDs that were expired.
   */
  expireOverdue(): string[] {
    const now = new Date();
    const expired: string[] = [];

    for (const dispute of this.disputes.values()) {
      if (
        (dispute.status === DisputeStatus.OPEN ||
          dispute.status === DisputeStatus.EVIDENCE) &&
        now > new Date(dispute.deadline)
      ) {
        dispute.status = DisputeStatus.EXPIRED;
        dispute.updatedAt = now.toISOString();
        expired.push(dispute.id);
      }
    }

    return expired;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Total number of disputes in the store. */
  get size(): number {
    return this.disputes.size;
  }

  /** Reset (testing only). */
  clear(): void {
    this.disputes.clear();
  }

  // ── Validation ────────────────────────────────────────────────────────

  /** @internal */
  private validateCreateParams(params: CreateDisputeParams): void {
    if (!params.claimant?.trim()) {
      throw new Error('claimant is required');
    }
    if (!params.respondent?.trim()) {
      throw new Error('respondent is required');
    }
    if (params.claimant === params.respondent) {
      throw new Error('claimant and respondent must be different');
    }
    if (!params.reason?.trim()) {
      throw new Error('reason is required');
    }
    if (params.deadline) {
      const dl = new Date(params.deadline);
      if (isNaN(dl.getTime())) {
        throw new Error('deadline must be a valid ISO-8601 date');
      }
      if (dl <= new Date()) {
        throw new Error('deadline must be in the future');
      }
    }
  }
}
