import type Database from "better-sqlite3";
import { getTenantId } from "../utils/tenantContext.js";

/** Row shape for the identities table. */
export interface Identity {
  id: number;
  address: string;
  tenant_id?: string;  // Add optional tenant_id field
  created_at: string;
}

/** Input for creating a new identity. */
export interface CreateIdentityInput {
  address: string;
  tenantId?: string;  // Allow tenant ID to be passed in for testing
}

/**
 * Repository for the `identities` table.
 * Provides basic CRUD operations for identity records.
 */
export class IdentitiesRepository {
  private db: Database.Database;
  private skipTenantCheck: boolean;  // Allow skipping tenant check in tests

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

  private scopedWhere(): { clause: string; params: string[] } {
    const tenantId = this.assertTenant();
    return tenantId
      ? { clause: "tenant_id = ?", params: [tenantId] }
      : { clause: "1 = 1", params: [] };
  }

  /**
   * Create a new identity.
   *
   * @param input - The identity data to insert.
   * @returns The newly created identity record.
   */
  create(input: CreateIdentityInput): Identity {
    const tenantId = this.skipTenantCheck ? input.tenantId : this.assertTenant();
    
    // Only include tenant_id in INSERT if it exists
    if (tenantId) {
      const stmt = this.db.prepare(
        "INSERT INTO identities (address, tenant_id) VALUES (@address, @tenantId)"
      );
      const result = stmt.run({ address: input.address, tenantId });
      return this.findById(result.lastInsertRowid as number)!;
    } else {
      const stmt = this.db.prepare(
        "INSERT INTO identities (address) VALUES (@address)"
      );
      const result = stmt.run({ address: input.address });
      return this.findById(result.lastInsertRowid as number)!;
    }
  }

  /**
   * Find an identity by its ID.
   *
   * @param id - The identity ID.
   * @returns The identity record, or undefined if not found.
   */
  findById(id: number): Identity | undefined {
    const scope = this.scopedWhere();
    const stmt = this.db.prepare(`SELECT * FROM identities WHERE id = ? AND ${scope.clause}`);
    return stmt.get(id, ...scope.params) as Identity | undefined;
  }

  /**
   * Find an identity by its on-chain address.
   *
   * @param address - The on-chain address.
   * @returns The identity record, or undefined if not found.
   */
  findByAddress(address: string): Identity | undefined {
    const scope = this.scopedWhere();
    const stmt = this.db.prepare(`SELECT * FROM identities WHERE address = ? AND ${scope.clause}`);
    return stmt.get(address, ...scope.params) as Identity | undefined;
  }

  /**
   * List all identities.
   *
   * @returns An array of all identity records.
   */
  findAll(): Identity[] {
    const scope = this.scopedWhere();
    const stmt = this.db.prepare(`SELECT * FROM identities WHERE ${scope.clause} ORDER BY id ASC`);
    return stmt.all(...scope.params) as Identity[];
  }
}
