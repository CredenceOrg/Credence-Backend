import type Database from "better-sqlite3";
import { getTenantId } from "../utils/tenantContext.js";

/** Row shape for the slash_events table. */
export interface SlashEvent {
  id: number;
  identity_id: number;
  amount: string;
  reason: string;
  evidence_ref: string | null;
  timestamp: string;
  created_at: string;
  tenant_id?: string; // Add optional tenant_id field
}

/** Input for creating a new slash event. */
export interface CreateSlashEventInput {
  identity_id: number;
  amount: string;
  reason: string;
  evidence_ref?: string | null;
  tenantId?: string; // Allow tenant ID to be passed in for testing
}

/**
 * Repository for the `slash_events` table.
 * Provides create and read operations for slash event records.
 */
export class SlashEventsRepository {
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
   * Create a new slash event.
   *
   * @param input - The slash event data to insert.
   * @returns The newly created slash event record.
   */
  create(input: CreateSlashEventInput): SlashEvent {
    const tenantId = input.tenantId || this.assertTenant();
    
    // Only include tenant_id in INSERT if it exists
    if (tenantId) {
      const stmt = this.db.prepare(
        "INSERT INTO slash_events (identity_id, amount, reason, evidence_ref, tenant_id) VALUES (@identity_id, @amount, @reason, @evidence_ref, @tenantId)"
      );
      const result = stmt.run({
        identity_id: input.identity_id,
        amount: input.amount,
        reason: input.reason,
        evidence_ref: input.evidence_ref ?? null,
        tenantId,
      });
      return this.findById(result.lastInsertRowid as number)!;
    } else {
      const stmt = this.db.prepare(
        "INSERT INTO slash_events (identity_id, amount, reason, evidence_ref) VALUES (@identity_id, @amount, @reason, @evidence_ref)"
      );
      const result = stmt.run({
        identity_id: input.identity_id,
        amount: input.amount,
        reason: input.reason,
        evidence_ref: input.evidence_ref ?? null,
      });
      return this.findById(result.lastInsertRowid as number)!;
    }
  }

  /**
   * Find a slash event by its ID.
   *
   * @param id - The slash event ID.
   * @returns The slash event record, or undefined if not found.
   */
  findById(id: number): SlashEvent | undefined {
    const stmt = this.db.prepare("SELECT * FROM slash_events WHERE id = ?");
    return stmt.get(id) as SlashEvent | undefined;
  }

  /**
   * Find all slash events for a given identity.
   *
   * @param identityId - The identity ID to look up.
   * @returns An array of slash event records for the identity.
   */
  findByIdentityId(identityId: number): SlashEvent[] {
    const stmt = this.db.prepare(
      "SELECT * FROM slash_events WHERE identity_id = ? ORDER BY id ASC"
    );
    return stmt.all(identityId) as SlashEvent[];
  }

  /**
   * List all slash events.
   *
   * @returns An array of all slash event records.
   */
  findAll(): SlashEvent[] {
    const stmt = this.db.prepare("SELECT * FROM slash_events ORDER BY id ASC");
    return stmt.all() as SlashEvent[];
  }
}