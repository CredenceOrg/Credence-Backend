import { randomUUID } from 'node:crypto'
import type { Queryable } from './queryable.js'

export interface Organization {
  id: string
  name: string
  createdAt: Date
}

interface OrganizationRow {
  id: string
  name: string
  created_at: Date | string
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const mapOrganization = (row: OrganizationRow): Organization => ({
  id: row.id,
  name: row.name,
  createdAt: toDate(row.created_at),
})

export class OrganizationRepository {
  constructor(private readonly db: Queryable) {}

  async create(name: string, id?: string): Promise<Organization> {
    const organizationId = id ?? randomUUID()
    const result = await this.db.query<OrganizationRow>(
      `
      INSERT INTO organizations (id, name)
      VALUES ($1, $2)
      RETURNING id, name, created_at
      `,
      [organizationId, name]
    )

    return mapOrganization(result.rows[0])
  }

  async listAll(): Promise<Organization[]> {
    const result = await this.db.query<OrganizationRow>(
      `
      SELECT id, name, created_at
      FROM organizations
      ORDER BY created_at ASC, id ASC
      `
    )

    return result.rows.map(mapOrganization)
  }
}
