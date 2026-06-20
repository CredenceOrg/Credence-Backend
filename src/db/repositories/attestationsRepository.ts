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
    this.assertTenant();
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
    this.assertTenant();
    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapAttestation(result.rows[0]) : null;
  }

  async listBySubject(subjectAddress: string): Promise<Attestation[]> {
    this.assertTenant();
    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE subject_address = $1
      ORDER BY created_at DESC, id DESC
      `,
      [subjectAddress],
    );

    return result.rows.map(mapAttestation);
  }

  async listBySubjectPage(
    subjectAddress: string,
    options: ListAttestationsPageOptions,
  ): Promise<AttestationPage> {
    this.assertTenant();
    const [items, count] = await Promise.all([
      this.db.query<AttestationRow>(
        `
        SELECT id, bond_id, attester_address, subject_address, score, note, created_at
        FROM attestations
        WHERE subject_address = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3
        `,
        [subjectAddress, options.limit, options.offset],
      ),
      this.db.query<{ total: string | number }>(
        `
        SELECT COUNT(*) AS total
        FROM attestations
        WHERE subject_address = $1
        `,
        [subjectAddress],
      ),
    ]);

    return {
      attestations: items.rows.map(mapAttestation),
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async listByBond(bondId: number): Promise<Attestation[]> {
    this.assertTenant();
    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE bond_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [bondId],
    );

    return result.rows.map(mapAttestation);
  }

  async updateScore(id: number, score: number): Promise<Attestation | null> {
    this.assertTenant();
    const result = await this.db.query<AttestationRow>(
      `
      UPDATE attestations
      SET score = $2
      WHERE id = $1
      RETURNING id, bond_id, attester_address, subject_address, score, note, created_at
      `,
      [id, score],
    );

    return result.rows[0] ? mapAttestation(result.rows[0]) : null;
  }

  async delete(id: number): Promise<boolean> {
    this.assertTenant();
    const result = await this.db.query(
      `
      DELETE FROM attestations
      WHERE id = $1
      `,
      [id],
    );

    return (result.rowCount ?? 0) > 0;
  }
}
