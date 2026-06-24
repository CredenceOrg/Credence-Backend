import type Database from "better-sqlite3";
import { getTenantId } from "../utils/tenantContext.js";

/** Row shape for the attestations table. */
export interface Attestation {
  id: number;
  verifier: string;
  identity_id: number;
  timestamp: string;
  weight: number;
  revoked: number;
  created_at: string;
  tenant_id?: string; // Add optional tenant_id field
}

/** Input for creating a new attestation. */
export interface CreateAttestationInput {
  verifier: string;
  identity_id: number;
  weight?: number;
  tenantId?: string; // Allow tenant ID to be passed in for testing
}

/**
 * Repository for the `attestations` table.
 * Provides create, read, and revoke operations for attestation records.
 */
export class AttestationsRepository {
  private db: Database.Database;
  private skipTenantCheck: boolean; // Allow skipping tenant check in tests

  /**
   * @param db - A better-sqlite3 Database instance with migrations already applied.
   * @param options - Optional configuration
   */
  constructor(db: Database.Database, options: { skipTenantCheck?: boolean } = {}) {
    this.db = db;
    this.skipTenantCheck = options.skipTenantCheck || false;
  }

  private assertTenant(): string | undefined {
    // Skip tenant check if explicitly disabled (useful for tests)
    if (this.skipTenantCheck) {
      return undefined;
    }
    
    const t = getTenantId();
    if (!t) throw new Error("Missing tenant context");
    return t;
  }

  /**
   * Create a new attestation.
   *
   * @param input - The attestation data to insert.
   * @returns The newly created attestation record.
   */
  create(input: CreateAttestationInput): Attestation {
    const tenantId = input.tenantId || this.assertTenant();
    const weight = input.weight ?? 1.0;
    
    // Only include tenant_id in INSERT if it exists
    if (tenantId) {
      const stmt = this.db.prepare(
        "INSERT INTO attestations (verifier, identity_id, weight, tenant_id) VALUES (@verifier, @identity_id, @weight, @tenantId)"
      );
      const result = stmt.run({
        verifier: input.verifier,
        identity_id: input.identity_id,
        weight,
        tenantId,
      });
      return this.findById(result.lastInsertRowid as number)!;
    } else {
      const stmt = this.db.prepare(
        "INSERT INTO attestations (verifier, identity_id, weight) VALUES (@verifier, @identity_id, @weight)"
      );
      const result = stmt.run({
        verifier: input.verifier,
        identity_id: input.identity_id,
        weight,
      });
      return this.findById(result.lastInsertRowid as number)!;
    }
  }

  /**
   * Find an attestation by its ID.
   *
   * @param id - The attestation ID.
   * @returns The attestation record, or undefined if not found.
   */
  findById(id: number): Attestation | undefined {
    const stmt = this.db.prepare("SELECT * FROM attestations WHERE id = ?");
    return stmt.get(id) as Attestation | undefined;
  }

  /**
   * Find all attestations for a given identity.
   *
   * @param identityId - The identity ID to look up.
   * @returns An array of attestation records for the identity.
   */
  findByIdentityId(identityId: number): Attestation[] {
    const stmt = this.db.prepare(
      "SELECT * FROM attestations WHERE identity_id = ? ORDER BY id ASC"
    );
    return stmt.all(identityId) as Attestation[];
  }

  /**
   * Revoke an attestation by setting its `revoked` flag to 1.
   *
   * @param id - The attestation ID to revoke.
   * @returns True if the attestation was found and updated, false otherwise.
   */
  revoke(id: number): boolean {
    const stmt = this.db.prepare(
      "UPDATE attestations SET revoked = 1 WHERE id = ?"
    );
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * List all attestations.
   *
   * @returns An array of all attestation records.
   */
  findAll(): Attestation[] {
    const stmt = this.db.prepare("SELECT * FROM attestations ORDER BY id ASC");
    return stmt.all() as Attestation[];
  }
}