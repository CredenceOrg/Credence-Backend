/**
 * Main reputation score calculation
 * Combines bond score, attestation score, and time weight
 */

import type { Queryable } from "../../db/repositories/queryable.js";
import type { ReputationInput, ReputationScore } from "./types.js";
import { calculateBondScore } from "./bondScore.js";
import { calculateAttestationScore } from "./attestationScore.js";
import { calculateTimeWeight } from "./timeWeight.js";
import { ScoreHistoryRepository } from "../../db/repositories/scoreHistoryRepository.js";
import type { ScoreSource } from "../../db/repositories/scoreHistoryRepository.js";

/**
 * Calculate comprehensive reputation score
 * Formula: totalScore = (bondScore + attestationScore) * timeWeight
 *
 * @param input - Reputation input data
 * @returns Reputation score breakdown
 */
export function calculateReputationScore(
  input: ReputationInput,
): ReputationScore {
  // Calculate individual components
  const bondScore = calculateBondScore(input.bond);
  const attestationScore = calculateAttestationScore(input.attestations);
  const timeWeight = calculateTimeWeight(
    input.bond.bondStart,
    input.currentTime,
  );

  // Apply formula: (bond + attestation) * timeWeight
  const totalScore = (bondScore + attestationScore) * timeWeight;

  return {
    totalScore,
    bondScore,
    attestationScore,
    timeWeight,
  };
}

/**
 * Normalize a raw score to the persisted integer range.
 */
export function normalizeScore(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.max(0, Math.round(score));
}

/**
 * Calculate a persisted reputation score from the raw input vector.
 */
export function calculatePersistedReputationScore(
  input: ReputationInput,
): number {
  return normalizeScore(calculateReputationScore(input).totalScore);
}

/**
 * Persist a score snapshot and its frozen input vector in the same transaction.
 * Caller should pass a transaction-aware Queryable (e.g. PoolClient) when
 * atomicity is required.
 */
export async function recordScoreHistorySnapshot(
  db: Queryable,
  identityAddress: string,
  source: ScoreSource,
  inputVector: ReputationInput,
  computedAt?: Date,
) {
  const score = calculatePersistedReputationScore(inputVector);
  const repository = new ScoreHistoryRepository(db);

  return repository.create({
    identityAddress,
    score,
    source,
    inputVector,
    computedAt,
  });
}

/**
 * Calculate reputation score with custom time weight parameters
 * @param input - Reputation input data
 * @param maxDuration - Maximum duration for full time weight
 * @returns Reputation score breakdown
 */
export function calculateReputationScoreWithCustomDuration(
  input: ReputationInput,
  maxDuration: number,
): ReputationScore {
  const bondScore = calculateBondScore(input.bond);
  const attestationScore = calculateAttestationScore(input.attestations);
  const timeWeight = calculateTimeWeight(
    input.bond.bondStart,
    input.currentTime,
    maxDuration,
  );

  const totalScore = (bondScore + attestationScore) * timeWeight;

  return {
    totalScore,
    bondScore,
    attestationScore,
    timeWeight,
  };
}
