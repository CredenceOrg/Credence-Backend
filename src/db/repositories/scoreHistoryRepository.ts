import type { Queryable } from "./queryable.js";
import type { ReputationInput } from "../../services/reputation/types.js";

export type ScoreSource = "bond" | "attestation" | "slash" | "manual";

export interface ScoreHistoryEntry {
  id: number;
  identityAddress: string;
  score: number;
  source: ScoreSource;
  inputVector: ReputationInput;
  computedAt: Date;
}

export interface CreateScoreHistoryInput {
  identityAddress: string;
  score: number;
  source: ScoreSource;
  inputVector: ReputationInput;
  computedAt?: Date;
}

type ScoreHistoryRow = {
  id: string | number;
  identity_address: string;
  score: number;
  source: ScoreSource;
  input_vector: ReputationInput;
  computed_at: Date | string;
};

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

const mapScoreHistory = (row: ScoreHistoryRow): ScoreHistoryEntry => ({
  id: Number(row.id),
  identityAddress: row.identity_address,
  score: row.score,
  source: row.source,
  inputVector: row.input_vector,
  computedAt: toDate(row.computed_at),
});

export class ScoreHistoryRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateScoreHistoryInput): Promise<ScoreHistoryEntry> {
    const result = await this.db.query<ScoreHistoryRow>(
      `
      INSERT INTO score_history (identity_address, score, source, input_vector, computed_at)
      VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
      RETURNING id, identity_address, score, source, input_vector, computed_at
      `,
      [
        input.identityAddress,
        input.score,
        input.source,
        input.inputVector,
        input.computedAt ?? null,
      ],
    );

    return mapScoreHistory(result.rows[0]);
  }

  async findById(id: number): Promise<ScoreHistoryEntry | null> {
    const result = await this.db.query<ScoreHistoryRow>(
      `
      SELECT id, identity_address, score, source, input_vector, computed_at
      FROM score_history
      WHERE id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapScoreHistory(result.rows[0]) : null;
  }

  async listByIdentity(identityAddress: string): Promise<ScoreHistoryEntry[]> {
    const result = await this.db.query<ScoreHistoryRow>(
      `
      SELECT id, identity_address, score, source, input_vector, computed_at
      FROM score_history
      WHERE identity_address = $1
      ORDER BY computed_at DESC, id DESC
      `,
      [identityAddress],
    );

    return result.rows.map(mapScoreHistory);
  }

  async findLatestByIdentity(
    identityAddress: string,
  ): Promise<ScoreHistoryEntry | null> {
    const result = await this.db.query<ScoreHistoryRow>(
      `
      SELECT id, identity_address, score, source, input_vector, computed_at
      FROM score_history
      WHERE identity_address = $1
      ORDER BY computed_at DESC, id DESC
      LIMIT 1
      `,
      [identityAddress],
    );

    return result.rows[0] ? mapScoreHistory(result.rows[0]) : null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query(
      `
      DELETE FROM score_history
      WHERE id = $1
      `,
      [id],
    );

    return (result.rowCount ?? 0) > 0;
  }
}
