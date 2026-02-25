/**
 * Types for reputation score calculation
 */

export interface BondData {
  bondedAmount: number
  bondStart: number // timestamp in ms
  bondDuration: number // duration in ms
  slashingHistory: number // count of slashing events
}

export interface Attestation {
  weight: number
  timestamp: number
  isValid: boolean
}

export interface ReputationInput {
  bond: BondData
  attestations: Attestation[]
  currentTime: number
}

export interface ReputationScore {
  totalScore: number
  bondScore: number
  attestationScore: number
  timeWeight: number
}
