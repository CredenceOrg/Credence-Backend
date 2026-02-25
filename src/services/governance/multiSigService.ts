/**
 * @module services/governance/multiSigService
 * @description Multi-signature proposal management for governance decisions.
 *
 * Lifecycle: PENDING → APPROVED (threshold met) or REJECTED / EXPIRED
 *            APPROVED → EXECUTED
 *
 * Rules:
 * - threshold must be > 0 and ≤ signers.length
 * - only listed signers can sign
 * - a signer can sign only once per proposal
 * - once threshold is reached the status auto-transitions to APPROVED
 * - a proposal can be explicitly rejected by the proposer
 * - expired proposals cannot be signed
 */

import { randomUUID } from 'node:crypto';

import type {
  MultiSigProposal,
  CreateMultiSigParams,
} from '../../types/governance.js';
import { MultiSigStatus } from '../../types/governance.js';

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_DEADLINE_DAYS = 7;

function defaultDeadline(days = DEFAULT_DEADLINE_DAYS): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ── Service ───────────────────────────────────────────────────────────────

/**
 * In-memory multi-sig proposal service.
 *
 * @example
 * ```ts
 * const svc = new MultiSigService();
 * const p = svc.create({ title: 'Upgrade', description: '...', proposer: '0xA', signers: ['0xA','0xB','0xC'], threshold: 2 });
 * svc.sign(p.id, '0xA');
 * svc.sign(p.id, '0xB'); // auto-approves because threshold = 2
 * ```
 */
export class MultiSigService {
  private readonly proposals = new Map<string, MultiSigProposal>();

  // ── Create ────────────────────────────────────────────────────────────

  /**
   * Create a new multi-sig proposal.
   *
   * @throws {Error} Validation failures.
   */
  create(params: CreateMultiSigParams): MultiSigProposal {
    this.validateCreateParams(params);

    const now = new Date().toISOString();
    const proposal: MultiSigProposal = {
      id: randomUUID(),
      title: params.title,
      description: params.description,
      proposer: params.proposer,
      status: MultiSigStatus.PENDING,
      signers: [...params.signers],
      signatures: [],
      threshold: params.threshold,
      createdAt: now,
      updatedAt: now,
      deadline: params.deadline ?? defaultDeadline(),
    };

    this.proposals.set(proposal.id, proposal);
    return { ...proposal };
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /** Find a proposal by ID. */
  getById(id: string): MultiSigProposal | undefined {
    const p = this.proposals.get(id);
    return p ? { ...p } : undefined;
  }

  /** Return all proposals. */
  list(): MultiSigProposal[] {
    return [...this.proposals.values()].map((p) => ({ ...p }));
  }

  // ── Sign ──────────────────────────────────────────────────────────────

  /**
   * Record a signer's approval.
   *
   * If the threshold is met after signing, the status automatically
   * transitions to APPROVED.
   *
   * @returns The updated proposal.
   * @throws {Error} Various validation errors (see rules in module docstring).
   */
  sign(id: string, signer: string): MultiSigProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`Proposal not found: ${id}`);

    if (proposal.status !== MultiSigStatus.PENDING) {
      throw new Error(
        `Cannot sign proposal in ${proposal.status} status`,
      );
    }

    if (new Date() > new Date(proposal.deadline)) {
      proposal.status = MultiSigStatus.EXPIRED;
      proposal.updatedAt = new Date().toISOString();
      throw new Error('Proposal has expired');
    }

    if (!proposal.signers.includes(signer)) {
      throw new Error(`${signer} is not an authorized signer`);
    }

    if (proposal.signatures.includes(signer)) {
      throw new Error(`${signer} has already signed this proposal`);
    }

    proposal.signatures.push(signer);
    proposal.updatedAt = new Date().toISOString();

    if (proposal.signatures.length >= proposal.threshold) {
      proposal.status = MultiSigStatus.APPROVED;
    }

    return { ...proposal };
  }

  // ── Reject ────────────────────────────────────────────────────────────

  /**
   * Explicitly reject a pending proposal.
   *
   * @throws {Error} If the proposal is not PENDING.
   */
  reject(id: string): MultiSigProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`Proposal not found: ${id}`);

    if (proposal.status !== MultiSigStatus.PENDING) {
      throw new Error(
        `Cannot reject proposal in ${proposal.status} status`,
      );
    }

    proposal.status = MultiSigStatus.REJECTED;
    proposal.updatedAt = new Date().toISOString();
    return { ...proposal };
  }

  // ── Execute ───────────────────────────────────────────────────────────

  /**
   * Mark an approved proposal as executed.
   *
   * @throws {Error} If the proposal is not APPROVED.
   */
  execute(id: string): MultiSigProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`Proposal not found: ${id}`);

    if (proposal.status !== MultiSigStatus.APPROVED) {
      throw new Error(
        `Cannot execute proposal in ${proposal.status} status`,
      );
    }

    proposal.status = MultiSigStatus.EXECUTED;
    proposal.updatedAt = new Date().toISOString();
    return { ...proposal };
  }

  // ── Expire ────────────────────────────────────────────────────────────

  /**
   * Expire all proposals past their deadline that are still PENDING.
   *
   * @returns IDs of expired proposals.
   */
  expireOverdue(): string[] {
    const now = new Date();
    const expired: string[] = [];

    for (const p of this.proposals.values()) {
      if (
        p.status === MultiSigStatus.PENDING &&
        now > new Date(p.deadline)
      ) {
        p.status = MultiSigStatus.EXPIRED;
        p.updatedAt = now.toISOString();
        expired.push(p.id);
      }
    }

    return expired;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Total proposals. */
  get size(): number {
    return this.proposals.size;
  }

  /** Reset (testing only). */
  clear(): void {
    this.proposals.clear();
  }

  // ── Validation ────────────────────────────────────────────────────────

  /** @internal */
  private validateCreateParams(params: CreateMultiSigParams): void {
    if (!params.title?.trim()) throw new Error('title is required');
    if (!params.description?.trim()) throw new Error('description is required');
    if (!params.proposer?.trim()) throw new Error('proposer is required');

    if (!params.signers?.length) throw new Error('at least one signer is required');
    if (new Set(params.signers).size !== params.signers.length) {
      throw new Error('signers must be unique');
    }

    if (!Number.isInteger(params.threshold) || params.threshold < 1) {
      throw new Error('threshold must be a positive integer');
    }
    if (params.threshold > params.signers.length) {
      throw new Error('threshold cannot exceed number of signers');
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
