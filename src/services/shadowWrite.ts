/**
 * Shadow write mode for pipeline migration
 * 
 * When SHADOW_WRITE_MODE is enabled (and NEW_PIPELINE is true),
 * writes go to both old and new pipelines and results are diffed
 * in metrics to validate the new pipeline before full migration.
 */

import { Settlement, CreateSettlementInput } from '../db/repositories/settlementsRepository.js'
import { recordShadowWriteMismatch } from '../middleware/metrics.js'
import type { SettlementsRepository } from '../db/repositories/settlementsRepository.js'

export interface ShadowWriteResult {
  oldResult: { settlement: Settlement; isDuplicate: boolean }
  newResult: { settlement: Settlement; isDuplicate: boolean }
  oldError?: Error
  newError?: Error
}

/**
 * Compare old and new pipeline results and record mismatches in metrics.
 * 
 * This function examines the results from both pipelines and detects:
 * - Status mismatches (e.g., settled vs pending)
 * - Data mismatches (e.g., different amounts or bond IDs)
 * - Error mismatches (e.g., one succeeded while the other failed)
 * 
 * @param result - Result object containing outcomes from both pipelines
 * @returns true if mismatches were detected
 */
export function diffAndRecordShadowWrites(result: ShadowWriteResult): boolean {
  let hasMismatch = false

  // Handle error mismatches
  if ((result.oldError === undefined) !== (result.newError === undefined)) {
    recordShadowWriteMismatch('error_mismatch')
    hasMismatch = true
    return hasMismatch
  }

  // If both failed, that's consistent behavior (not a mismatch)
  if (result.oldError && result.newError) {
    return false
  }

  // Both succeeded; compare the results
  if (result.oldResult && result.newResult) {
    const oldSettlement = result.oldResult.settlement
    const newSettlement = result.newResult.settlement

    // Check status mismatch
    if (oldSettlement.status !== newSettlement.status) {
      recordShadowWriteMismatch('status_mismatch')
      hasMismatch = true
    }

    // Check data mismatch (amount, bond ID, transaction hash should be identical)
    if (
      oldSettlement.amount !== newSettlement.amount ||
      oldSettlement.bondId !== newSettlement.bondId ||
      oldSettlement.transactionHash !== newSettlement.transactionHash
    ) {
      recordShadowWriteMismatch('data_mismatch')
      hasMismatch = true
    }

    // Check duplicate detection mismatch
    if (result.oldResult.isDuplicate !== result.newResult.isDuplicate) {
      recordShadowWriteMismatch('data_mismatch')
      hasMismatch = true
    }
  }

  return hasMismatch
}

/**
 * Execute shadow write: attempt writes to both old and new pipelines.
 * 
 * - Both pipelines are executed in parallel (via Promise.all)
 * - Errors from one pipeline do not prevent the other from running
 * - Results and errors are captured and compared for metrics
 * - The old pipeline result is returned to the caller
 * 
 * @param oldRepository - The old/current settlements repository
 * @param newRepository - The new settlements repository (can be the same instance with different logic)
 * @param input - Settlement creation input to write to both pipelines
 * @returns The result from the old pipeline (primary) along with metrics about mismatches
 */
export async function executeShadowWrite(
  oldRepository: SettlementsRepository,
  newRepository: SettlementsRepository,
  input: CreateSettlementInput
): Promise<{
  primaryResult: { settlement: Settlement; isDuplicate: boolean }
  hadMismatch: boolean
}> {
  // Execute both pipelines in parallel, capturing both results and errors
  const [oldOutcome, newOutcome] = await Promise.allSettled([
    oldRepository.upsert(input),
    newRepository.upsert(input),
  ])

  const result: ShadowWriteResult = {
    oldResult: undefined as any,
    newResult: undefined as any,
    oldError: undefined,
    newError: undefined,
  }

  if (oldOutcome.status === 'fulfilled') {
    result.oldResult = oldOutcome.value
  } else {
    result.oldError = oldOutcome.reason
  }

  if (newOutcome.status === 'fulfilled') {
    result.newResult = newOutcome.value
  } else {
    result.newError = newOutcome.reason
  }

  // Compare and record mismatches
  const hadMismatch = diffAndRecordShadowWrites(result)

  // Return old pipeline result (primary) or throw if it failed
  if (result.oldError) {
    throw result.oldError
  }

  return {
    primaryResult: result.oldResult,
    hadMismatch,
  }
}
