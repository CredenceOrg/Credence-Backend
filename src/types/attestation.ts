/**
 * @module types/attestation
 * @description Type definitions for the Credence attestation system.
 *
 * An **attestation** is a signed statement made by a *verifier* about a
 * *subject* identity.  Each attestation carries a numeric `weight`
 * (0–100) indicating the verifier's confidence and can be revoked at any
 * time, which sets `revokedAt` without deleting the record.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Core entity
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single attestation record.
 *
 * Revoked attestations remain in storage but are excluded from counts
 * and lists by default.
 */
export interface Attestation {
  /** Unique identifier (UUID v4). */
  id: string;
  /** The identity (address / DID) being attested. */
  subject: string;
  /** The identity (address / DID) of the verifier issuing the attestation. */
  verifier: string;
  /** Numeric weight / confidence score (0–100). */
  weight: number;
  /** Free-form attestation content or claim. */
  claim: string;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of revocation, or `null` if still active. */
  revokedAt: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// API request / response helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Query-string parameters accepted by `GET /api/attestations/:identity`. */
export interface AttestationListQuery {
  /** Page number (1-based, default 1). */
  page?: number;
  /** Items per page (default 20, max 100). */
  limit?: number;
  /** When `true`, include revoked attestations (default `false`). */
  includeRevoked?: boolean;
}

/** Shape returned by the list endpoint. */
export interface AttestationListResponse {
  identity: string;
  attestations: Attestation[];
  limit: number;
  hasNextPage: boolean;
  nextCursor?: string;
}

/** Shape returned by the count endpoint. */
export interface AttestationCountResponse {
  identity: string;
  count: number;
  /** When `true`, the count includes revoked attestations. */
  includeRevoked: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Parameters for creating an attestation
// ═══════════════════════════════════════════════════════════════════════════

/** Parameters for creating a new attestation. */
export interface CreateAttestationParams {
  subject: string;
  verifier: string;
  weight: number;
  claim: string;
}
