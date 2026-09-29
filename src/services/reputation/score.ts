/**
 * Main reputation score calculation
 * Combines bond score, attestation score, and time weight
 */

import type { Queryable } from "../../db/repositories/queryable.js";
import type { ReputationInput, ReputationModuleConfig, ReputationScore } from "./types.js";
import { calculateBondScore } from "./bondScore.js";
import { calculateAttestationScore } from "./attestationScore.js";
import { calculateTimeWeight } from "./timeWeight.js";
import { ScoreHistoryRepository } from "../../db/repositories/scoreHistoryRepository.js";
import type { ScoreSource } from "../../db/repositories/scoreHistoryRepository.js";
import { ReputationSpans, getReputationTracer } from "../../tracing/tracer.js";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";

/**
 * Traced reputation score computation pipeline.
 *
 * Span tree:
 * - `reputation.compute` (parent)
 *   - `reputation.bond_score`
 *   - `reputation.attestation_score`
 *   - `reputation.time_weight`
 *
 * Parent span attributes:
 * - `reputation.identity_id` (optional, caller-provided non-PII reference)
 * - `reputation.input_vector_size`
 * - `reputation.result_score`
 *
 * Child span attributes:
 * - `reputation.stage_result`
 *
 * @param input - Reputation input data
 * @param identityId - Optional non-PII identity reference used for tracing
 * @returns Reputation score breakdown
 */
export function calculateReputationScore(
  input: ReputationInput,
  identityId?: string,
  config?: ReputationModuleConfig,
): ReputationScore {
  const tracer = getReputationTracer();

  return tracer.startActiveSpan(ReputationSpans.COMPUTE, (computeSpan) => {
    try {
      if (identityId) {
        computeSpan.setAttribute("reputation.identity_id", identityId);
      }
      computeSpan.setAttribute(
        "reputation.input_vector_size",
        input.attestations.length + 1,
      );

      const parentCtx = trace.setSpan(context.active(), computeSpan);

      // Calculate individual components
      const bondScore = tracer.startActiveSpan(
        ReputationSpans.BOND_SCORE,
        {},
        parentCtx,
        (span) => {
          try {
            const result = calculateBondScore(input.bond, config);
            span.setAttribute("reputation.stage_result", result);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : "Unknown error",
            });
            throw error;
          } finally {
            span.end();
          }
        },
      );

      const attestationScore = tracer.startActiveSpan(
        ReputationSpans.ATTESTATION_SCORE,
        {},
        parentCtx,
        (span) => {
          try {
            const result = calculateAttestationScore(input.attestations, config);
            span.setAttribute("reputation.stage_result", result);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : "Unknown error",
            });
            throw error;
          } finally {
            span.end();
          }
        },
      );

      const timeWeight = tracer.startActiveSpan(
        ReputationSpans.TIME_WEIGHT,
        {},
        parentCtx,
        (span) => {
          try {
            const result = calculateTimeWeight(
              input.bond.bondStart,
              input.currentTime,
              undefined,
              config,
            );
            span.setAttribute("reputation.stage_result", result);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : "Unknown error",
            });
            throw error;
          } finally {
            span.end();
          }
        },
      );

      // Apply formula: (bond + attestation) * timeWeight
      const totalScore = (bondScore + attestationScore) * timeWeight;
      computeSpan.setAttribute("reputation.result_score", totalScore);
      computeSpan.setStatus({ code: SpanStatusCode.OK });

      return {
        totalScore,
        bondScore,
        attestationScore,
        timeWeight,
      };
    } catch (error) {
      computeSpan.recordException(error as Error);
      computeSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    } finally {
      computeSpan.end();
    }
  });
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
  identityId?: string,
  config?: ReputationModuleConfig,
): number {
  return normalizeScore(calculateReputationScore(input, identityId, config).totalScore);
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
  config?: ReputationModuleConfig,
) {
  const score = calculatePersistedReputationScore(inputVector, identityAddress, config);
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
  config?: ReputationModuleConfig,
): ReputationScore {
  const bondScore = calculateBondScore(input.bond, config);
  const attestationScore = calculateAttestationScore(input.attestations, config);
  const timeWeight = calculateTimeWeight(
    input.bond.bondStart,
    input.currentTime,
    maxDuration,
    config,
  );

  const totalScore = (bondScore + attestationScore) * timeWeight;

  return {
    totalScore,
    bondScore,
    attestationScore,
    timeWeight,
  };
}
