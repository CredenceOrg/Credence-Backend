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

/**
 * Repository for the `score_history` table.
 *
 * Invariants:
 * - `id` is a non-negative integer. Non-finite or fractional ids are
 *   rejected before hitting the DB, so a bad caller cannot accidentally
 *   match a row via implicit coercion.
 * - `identityAddress` must be a non-empty string; we trim before validation
 *   so whitespace-only inputs are rejected deterministically.
 * - `score` must be a finite number. NaN / Infinity are rejected because
 *   they would poison downstream aggregations.
 * - `computedAt`, when provided, must be a valid Date.
 * - Retries and concurrent calls are safe: all mutations are a single
 *   statement and the repository never caches or retains mutable state.
 */
export class ScoreHistoryRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateScoreHistoryInput): Promise<ScoreHistoryEntry> {
    const identityAddress = assertIdentityAddress(input.identityAddress);
    const score = assertScore(input.score);
    const computedAt = assertOptionalDate(input.computedAt);

    const result = await this.db.query<ScoreHistoryRow>(
      `
      INSERT INTO score_history (identity_address, score, source, input_vector, computed_at)
      VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
      RETURNING id, identity_address, score, source, input_vector, computed_at
      `,
      [identityAddress, score, input.source, input.inputVector, computedAt],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        "ScoreHistoryRepository.create: insert returned no row",
      );
    }

    return mapScoreHistory(row);
  }

  async findById(id: number): Promise<ScoreHistoryEntry | null> {
    const normalizedId = assertId(id);

    const result = await this.db.query<ScoreHistoryRow>(
      `
      SELECT id, identity_address, score, source, input_vector, computed_at
      FROM score_history
      WHERE id = $1
      `,
      [normalizedId],
    );

    return result.rows[0] ? mapScoreHistory(result.rows[0]) : null;
  }

  async listByIdentity(identityAddress: string): Promise<ScoreHistoryEntry[]> {
    const normalizedAddress = assertIdentityAddress(identityAddress);

    const result = await this.db.query<ScoreHistoryRow>(
      `
      SELECT id, identity_address, score, source, input_vector, computed_at
      FROM score_history
      WHERE identity_address = $1
      ORDER BY computed_at DESC, id DESC
      `,
      [normalizedAddress],
    );

    return result.rows.map(mapScoreHistory);
  }

  async findLatestByIdentity(
    identityAddress: string,
  ): Promise<ScoreHistoryEntry | null> {
    const normalizedAddress = assertIdentityAddress(identityAddress);

    const result = await this.db.query<ScoreHistoryRow>(
      `
      SELECT id, identity_address, score, source, input_vector, computed_at
      FROM score_history
      WHERE identity_address = $1
      ORDER BY computed_at DESC, id DESC
      LIMIT 1
      `,
      [normalizedAddress],
    );

    return result.rows[0] ? mapScoreHistory(result.rows[0]) : null;
  }

  async delete(id: number): Promise<boolean> {
    const normalizedId = assertId(id);

    const result = await this.db.query(
      `
      DELETE FROM score_history
      WHERE id = $1
      `,
      [normalizedId],
    );

    return (result.rowCount ?? 0) > 0;
  }
}

const assertId = (id: number): number => {
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    throw new RangeError(
      `ScoreHistoryRepository: id must be a non-negative integer, received ${String(id)}`,
    );
  }
  return id;
};

const assertIdentityAddress = (address: string): string => {
  if (typeof address !== "string") {
    throw new TypeError(
      `ScoreHistoryRepository: identityAddress must be a string, received ${typeof address}`,
    );
  }
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    throw new Error(
      "ScoreHistoryRepository: identityAddress must be a non-empty string",
    );
  }
  return trimmed;
};

const assertScore = (score: number): number => {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new RangeError(
      `ScoreHistoryRepository: score must be a finite number, received ${String(score)}`,
    );
  }
  return score;
};

const assertOptionalDate = (value: Date | undefined): Date | null => {
  if (value === undefined) {
    return null;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(
      "ScoreHistoryRepository: computedAt must be a valid Date",
    );
  }
  return value;
};
