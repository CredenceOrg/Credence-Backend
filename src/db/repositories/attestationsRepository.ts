import type { Queryable } from "./queryable.js";
import { BaseRepository } from "./baseRepository.js";

export interface Attestation {
  id: number;
  bondId: number;
  attesterAddress: string;
  subjectAddress: string;
  score: number;
  note: string | null;
  createdAt: Date;
}

export interface CreateAttestationInput {
  bondId: number;
  attesterAddress: string;
  subjectAddress: string;
  score: number;
  note?: string | null;
}

export interface ListAttestationsPageOptions {
  offset: number;
  limit: number;
}

export interface AttestationPage {
  attestations: Attestation[];
  total: number;
}

export interface CursorPaginationOptions {
  limit: number;
  cursor?: { t: string; i: string };
}

export interface AttestationCursorPage {
  attestations: Attestation[];
  hasMore: boolean;
}

type AttestationRow = {
  id: string | number;
  bond_id: string | number;
  attester_address: string;
  subject_address: string;
  score: number;
  note: string | null;
  created_at: Date | string;
};

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

const mapAttestation = (row: AttestationRow): Attestation => ({
  id: Number(row.id),
  bondId: Number(row.bond_id),
  attesterAddress: row.attester_address,
  subjectAddress: row.subject_address,
  score: row.score,
  note: row.note,
  createdAt: toDate(row.created_at),
});

export class AttestationsRepository extends BaseRepository {

  async create(input: CreateAttestationInput): Promise<Attestation> {
    const tenantId = this.assertTenant();
    const bondCheck = await this.db.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM bonds WHERE id = $1 AND tenant_id = $2
      ) AS exists
      `,
      [input.bondId, tenantId],
    );
    if (!bondCheck.rows[0]?.exists) {
      throw new Error("Bond not found for current tenant");
    }

    const result = await this.db.query<AttestationRow>(
      `
      INSERT INTO attestations (bond_id, attester_address, subject_address, score, note)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, bond_id, attester_address, subject_address, score, note, created_at
      `,
      [
        input.bondId,
        input.attesterAddress,
        input.subjectAddress,
        input.score,
        input.note ?? null,
      ],
    );

    return mapAttestation(result.rows[0]);
  }

  async findById(id: number): Promise<Attestation | null> {
    const tenantId = this.assertTenant();
    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE id = $1
        AND bond_id IN (SELECT id FROM bonds WHERE tenant_id = $2)
      `,
      [id, tenantId],
    );

    return result.rows[0] ? mapAttestation(result.rows[0]) : null;
  }

  async listBySubject(subjectAddress: string): Promise<Attestation[]> {
    const tenantId = this.assertTenant();
    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE subject_address = $1
        AND bond_id IN (SELECT id FROM bonds WHERE tenant_id = $2)
      ORDER BY created_at DESC, id DESC
      `,
      [subjectAddress, tenantId],
    );

    return result.rows.map(mapAttestation);
  }

  async listBySubjectPage(
    subjectAddress: string,
    options: ListAttestationsPageOptions,
  ): Promise<AttestationPage> {
    const tenantId = this.assertTenant();
    const [items, count] = await Promise.all([
      this.db.query<AttestationRow>(
        `
        SELECT id, bond_id, attester_address, subject_address, score, note, created_at
        FROM attestations
        WHERE subject_address = $1
          AND bond_id IN (SELECT id FROM bonds WHERE tenant_id = $4)
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3
        `,
        [subjectAddress, options.limit, options.offset, tenantId],
      ),
      this.db.query<{ total: string | number }>(
        `
        SELECT COUNT(*) AS total
        FROM attestations
        WHERE subject_address = $1
          AND bond_id IN (SELECT id FROM bonds WHERE tenant_id = $2)
        `,
        [subjectAddress, tenantId],
      ),
    ]);

    return {
      attestations: items.rows.map(mapAttestation),
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async listByBond(bondId: number): Promise<Attestation[]> {
    const tenantId = this.assertTenant();
    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE bond_id = $1
        AND bond_id IN (SELECT id FROM bonds WHERE tenant_id = $2)
      ORDER BY created_at DESC, id DESC
      `,
      [bondId, tenantId],
    );

    return result.rows.map(mapAttestation);
  }

  async updateScore(id: number, score: number): Promise<Attestation | null> {
    const tenantId = this.assertTenant();
    const result = await this.db.query<AttestationRow>(
      `
      UPDATE attestations
      SET score = $2
      WHERE id = $1
        AND bond_id IN (SELECT id FROM bonds WHERE tenant_id = $3)
      RETURNING id, bond_id, attester_address, subject_address, score, note, created_at
      `,
      [id, score, tenantId],
    );

    return result.rows[0] ? mapAttestation(result.rows[0]) : null;
  }

  async delete(id: number): Promise<boolean> {
    const tenantId = this.assertTenant();
    const result = await this.db.query(
      `
      DELETE FROM attestations
      WHERE id = $1
        AND bond_id IN (SELECT id FROM bonds WHERE tenant_id = $2)
      `,
      [id, tenantId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Fetches attestations for a subject using cursor-based pagination.
   * Uses stable sort (created_at DESC, id DESC) to prevent duplicate/skipped rows on concurrent inserts.
   * @param subjectAddress The subject address
   * @param options Pagination options with cursor
   * @returns Attestations and hasMore flag
   */
  async listBySubjectPaginated(
    subjectAddress: string,
    options: CursorPaginationOptions,
  ): Promise<AttestationCursorPage> {
    const tenantId = this.assertTenant();
    
    // Fetch limit + 1 to determine if there are more results
    const fetchLimit = options.limit + 1;
    const values: any[] = [subjectAddress, tenantId, fetchLimit];
    let whereClause = "WHERE subject_address = $1 AND bond_id IN (SELECT id FROM bonds WHERE tenant_id = $2)";
    let paramIndex = 4;

    if (options.cursor) {
      whereClause += ` AND (created_at, id) < ($${paramIndex}, $${paramIndex + 1})`;
      values.push(options.cursor.t, options.cursor.i);
    }

    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $3
      `,
      values,
    );

    const hasMore = result.rows.length > options.limit;
    const attestations = result.rows.slice(0, options.limit).map(mapAttestation);

    return {
      attestations,
      hasMore,
    };
  }
}
