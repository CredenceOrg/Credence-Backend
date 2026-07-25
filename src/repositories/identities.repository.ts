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

  /**
   * Create a new identity.
   *
   * @param input - The identity data to insert.
   * @returns The newly created identity record.
   */
  create(input: CreateIdentityInput): Identity {
    const tenantId = input.tenantId || this.assertTenant();
    
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
    const stmt = this.db.prepare("SELECT * FROM identities WHERE id = ?");
    return stmt.get(id) as Identity | undefined;
  }

  /**
   * Find an identity by its on-chain address.
   *
   * @param address - The on-chain address.
   * @returns The identity record, or undefined if not found.
   */
  findByAddress(address: string): Identity | undefined {
    const stmt = this.db.prepare("SELECT * FROM identities WHERE address = ?");
    return stmt.get(address) as Identity | undefined;
  }

  /**
   * List all identities.
   *
   * @returns An array of all identity records.
   */
  findAll(): Identity[] {
    const stmt = this.db.prepare("SELECT * FROM identities ORDER BY id ASC");
    return stmt.all() as Identity[];
  }
}