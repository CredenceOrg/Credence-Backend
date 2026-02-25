import type { Queryable } from './queryable.js'

export interface Identity {
  address: string
  displayName: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateIdentityInput {
  address: string
  displayName?: string | null
}

export interface UpdateIdentityInput {
  displayName: string | null
}

type IdentityRow = {
  address: string
  display_name: string | null
  created_at: Date | string
  updated_at: Date | string
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const mapIdentity = (row: IdentityRow): Identity => ({
  address: row.address,
  displayName: row.display_name,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
})

export class IdentitiesRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateIdentityInput): Promise<Identity> {
    const result = await this.db.query<IdentityRow>(
      `
      INSERT INTO identities (address, display_name)
      VALUES ($1, $2)
      RETURNING address, display_name, created_at, updated_at
      `,
      [input.address, input.displayName ?? null]
    )

    return mapIdentity(result.rows[0])
  }

  async findByAddress(address: string): Promise<Identity | null> {
    const result = await this.db.query<IdentityRow>(
      `
      SELECT address, display_name, created_at, updated_at
      FROM identities
      WHERE address = $1
      `,
      [address]
    )

    return result.rows[0] ? mapIdentity(result.rows[0]) : null
  }

  async list(): Promise<Identity[]> {
    const result = await this.db.query<IdentityRow>(
      `
      SELECT address, display_name, created_at, updated_at
      FROM identities
      ORDER BY created_at ASC, address ASC
      `
    )

    return result.rows.map(mapIdentity)
  }

  async update(
    address: string,
    input: UpdateIdentityInput
  ): Promise<Identity | null> {
    const result = await this.db.query<IdentityRow>(
      `
      UPDATE identities
      SET display_name = $2,
          updated_at = NOW()
      WHERE address = $1
      RETURNING address, display_name, created_at, updated_at
      `,
      [address, input.displayName]
    )

    return result.rows[0] ? mapIdentity(result.rows[0]) : null
  }

  async delete(address: string): Promise<boolean> {
    const result = await this.db.query(
      `
      DELETE FROM identities
      WHERE address = $1
      `,
      [address]
    )

    return (result.rowCount ?? 0) > 0
  }
}
