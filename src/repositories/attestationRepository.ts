/**
 * @module repositories/attestationRepository
 * @description In-memory repository for {@link Attestation} records.
 *
 * Provides CRUD-like operations plus query helpers needed by the public
 * API (count by identity, paginated list, revoked filtering).
 *
 * In production this would be backed by a database; the in-memory
 * implementation lets us develop and test without external dependencies.
 */

import { randomUUID } from 'node:crypto';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';

import type {
  Attestation,
  CreateAttestationParams,
} from '../types/attestation.js';

/**
 * In-memory attestation store.
 *
 * @example
 * ```ts
 * const repo = new AttestationRepository();
 * const att = repo.create({ subject: '0xA', verifier: '0xV', weight: 80, claim: 'KYC passed' });
 * const count = repo.countBySubject('0xA');
 * ```
 */
export class AttestationRepository {
  private readonly store: Attestation[] = [];

  // ── Create ────────────────────────────────────────────────────────────

  /**
   * Persist a new attestation.
   *
   * @param params - Attestation data.
   * @returns The created attestation with generated `id` and timestamps.
   * @throws {Error} If required fields are missing or weight is out of range.
   */
  create(params: CreateAttestationParams): Attestation {
    if (!params.subject?.trim()) throw new Error('subject is required');
    if (!params.verifier?.trim()) throw new Error('verifier is required');
    if (!params.claim?.trim()) throw new Error('claim is required');
    if (
      typeof params.weight !== 'number' ||
      Number.isNaN(params.weight) ||
      params.weight < 0 ||
      params.weight > 100
    ) {
      throw new Error('weight must be a number between 0 and 100');
    }

    const attestation: Attestation = {
      id: randomUUID(),
      subject: params.subject,
      verifier: params.verifier,
      weight: params.weight,
      claim: params.claim,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };

    this.store.push(attestation);
    return { ...attestation };
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /** Find an attestation by its ID. */
  findById(id: string): Attestation | undefined {
    const att = this.store.find((a) => a.id === id);
    return att ? { ...att } : undefined;
  }

  /**
   * Return attestations for a subject with optional filtering and pagination.
   *
   * @param subject        - The identity to look up.
   * @param includeRevoked - Whether to include revoked attestations (default `false`).
   * @param page           - 1-based page number (default 1).
   * @param limit          - Page size (default 20, clamped to 1–100).
   * @returns `{ attestations, total }` where `total` is the pre-pagination count.
   */
  findBySubject(
    subject: string,
    {
      includeRevoked = false,
      offset = 0,
      limit = 20,
      cursor,
    }: { includeRevoked?: boolean; offset?: number; limit?: number; cursor?: string } = {},
  ): { attestations: Attestation[]; hasNextPage: boolean; nextCursor?: string } {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

    let results = this.store.filter((a) => a.subject === subject);

    if (!includeRevoked) {
      results = results.filter((a) => a.revokedAt === null);
    }

    // Sort newest-first. Tie-breaker by descending ID for stability.
    results = [...results].sort((a, b) => {
      const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.id.localeCompare(a.id);
    });

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        results = results.filter((a) => {
          return a.createdAt < decoded.t || (a.createdAt === decoded.t && a.id < decoded.i);
        });
      }
    } else if (offset > 0) {
      results = results.slice(offset);
    }

    // Fetch limit + 1 to determine if there are more
    const sliced = results.slice(0, safeLimit + 1);
    const hasNextPage = sliced.length > safeLimit;

    const attestations = sliced.slice(0, safeLimit).map((a) => ({ ...a }));
    let nextCursor: string | undefined;

    if (hasNextPage && attestations.length > 0) {
      const last = attestations[attestations.length - 1];
      nextCursor = encodeCursor(last.createdAt, last.id);
    }

    return { attestations, hasNextPage, nextCursor };
  }

  /**
   * Count attestations for a subject.
   *
   * @param subject        - The identity to count.
   * @param includeRevoked - Whether to include revoked attestations (default `false`).
   */
  countBySubject(subject: string, includeRevoked = false): number {
    return this.store.filter(
      (a) =>
        a.subject === subject &&
        (includeRevoked || a.revokedAt === null),
    ).length;
  }

  // ── Revoke ────────────────────────────────────────────────────────────

  /**
   * Revoke an attestation by setting its `revokedAt` timestamp.
   *
   * @returns The updated attestation, or `undefined` if not found.
   * @throws {Error} If the attestation is already revoked.
   */
  revoke(id: string): Attestation | undefined {
    const att = this.store.find((a) => a.id === id);
    if (!att) return undefined;
    if (att.revokedAt !== null) {
      throw new Error(`Attestation ${id} is already revoked`);
    }
    att.revokedAt = new Date().toISOString();
    return { ...att };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Total number of attestations in the store. */
  get size(): number {
    return this.store.length;
  }

  /** Reset all data (testing only). */
  clear(): void {
    this.store.length = 0;
  }
}
