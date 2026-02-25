import type { Vote, VoteInput, VoteSummary } from './types.js'

const store = new Map<string, Vote[]>()

const DEFAULT_THRESHOLD = 0.66 // 66% supermajority

export function resetStore(): void {
  store.clear()
}

export function castVote(input: VoteInput): Vote {
  if (!input.proposalId || typeof input.proposalId !== 'string') {
    throw new Error('proposalId is required')
  }
  if (!input.voter || typeof input.voter !== 'string') {
    throw new Error('voter is required')
  }
  if (typeof input.weight !== 'number' || input.weight <= 0) {
    throw new Error('weight must be a positive number')
  }
  if (typeof input.inFavor !== 'boolean') {
    throw new Error('inFavor must be a boolean')
  }

  const existing = store.get(input.proposalId) ?? []
  const alreadyVoted = existing.some((v) => v.voter === input.voter)
  if (alreadyVoted) {
    throw new Error(`Voter ${input.voter} has already voted on proposal ${input.proposalId}`)
  }

  const vote: Vote = {
    proposalId: input.proposalId,
    voter: input.voter,
    weight: input.weight,
    inFavor: input.inFavor,
    castAt: new Date(),
  }

  existing.push(vote)
  store.set(input.proposalId, existing)
  return vote
}

export function getVotes(proposalId: string): Vote[] {
  return store.get(proposalId) ?? []
}

export function countVotes(proposalId: string): { totalFor: number; totalAgainst: number } {
  const votes = store.get(proposalId) ?? []
  let totalFor = 0
  let totalAgainst = 0

  for (const v of votes) {
    if (v.inFavor) {
      totalFor += v.weight
    } else {
      totalAgainst += v.weight
    }
  }

  return { totalFor, totalAgainst }
}

export function hasReachedThreshold(
  proposalId: string,
  threshold: number = DEFAULT_THRESHOLD,
): boolean {
  if (threshold <= 0 || threshold > 1) {
    throw new Error('Threshold must be between 0 (exclusive) and 1 (inclusive)')
  }

  const { totalFor, totalAgainst } = countVotes(proposalId)
  const total = totalFor + totalAgainst
  if (total === 0) return false

  return totalFor / total >= threshold
}

export function getVoteSummary(
  proposalId: string,
  threshold: number = DEFAULT_THRESHOLD,
): VoteSummary {
  const votes = store.get(proposalId) ?? []
  const { totalFor, totalAgainst } = countVotes(proposalId)

  return {
    proposalId,
    totalFor,
    totalAgainst,
    voterCount: votes.length,
    reachedThreshold: hasReachedThreshold(proposalId, threshold),
  }
}
