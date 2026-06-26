import type { Queryable } from "./queryable.js";
import { BaseRepository } from "./baseRepository.js";

export interface Identity {
  address: string;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface CreateIdentityInput {
  address: string;
  displayName?: string | null;
}

export interface UpdateIdentityInput {
  displayName: string | null;
}

export interface UpdateIdentityWithVersionInput {
  displayName: string | null;
  expectedVersion: number;
}

type IdentityRow = {
  address: string;
  display_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

const mapIdentity = (row: IdentityRow): Identity => ({
  address: row.address,
  displayName: row.display_name,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
  version: row.version,
});

export class IdentitiesRepository extends BaseRepository {

  async create(input: CreateIdentityInput): Promise<Identity> {
    this.assertTenant();
    const result = await this.db.query<IdentityRow>(
      `
      INSERT INTO identities (address, display_name)
      VALUES ($1, $2)
      RETURNING address, display_name, created_at, updated_at, version
      `,
      [input.address, input.displayName ?? null],
    );

    return mapIdentity(result.rows[0]);
  }

  async findByAddress(address: string): Promise<Identity | null> {
    this.assertTenant();
    const result = await this.db.query<IdentityRow>(
      `
      SELECT address, display_name, created_at, updated_at, version
      FROM identities
      WHERE address = $1
      `,
      [address],
    );

    return result.rows[0] ? mapIdentity(result.rows[0]) : null;
  }

  async list(): Promise<Identity[]> {
    this.assertTenant();
    const result = await this.db.query<IdentityRow>(
      `
      SELECT address, display_name, created_at, updated_at, version
      FROM identities
      ORDER BY created_at ASC, address ASC
      `,
    );

    return result.rows.map(mapIdentity);
  }

  async update(
    address: string,
    input: UpdateIdentityInput,
  ): Promise<Identity | null> {
    this.assertTenant();
    const result = await this.db.query<IdentityRow>(
      `
      UPDATE identities
      SET display_name = $2,
          updated_at = NOW(),
          version = version + 1
      WHERE address = $1
      RETURNING address, display_name, created_at, updated_at, version
      `,
      [address, input.displayName],
    );

    return result.rows[0] ? mapIdentity(result.rows[0]) : null;
  }

  /**
   * Updates an identity with optimistic locking.
   * Only updates if the current version matches the expected version.
   * Returns null if the version has changed (concurrent modification detected).
   * On success, increments the version and returns the updated identity.
   */
  async updateWithOptimisticLocking(
    address: string,
    input: UpdateIdentityWithVersionInput,
  ): Promise<Identity | null> {
    this.assertTenant();
    const result = await this.db.query<IdentityRow>(
      `
      UPDATE identities
      SET display_name = $2,
          updated_at = NOW(),
          version = version + 1
      WHERE address = $1 AND version = $3
      RETURNING address, display_name, created_at, updated_at, version
      `,
      [address, input.displayName, input.expectedVersion],
    );

    return result.rows[0] ? mapIdentity(result.rows[0]) : null;
  }

  async delete(address: string): Promise<boolean> {
    this.assertTenant();
    const result = await this.db.query(
      `
      DELETE FROM identities
      WHERE address = $1
      `,
      [address],
    );

    return (result.rowCount ?? 0) > 0;
  }
}
