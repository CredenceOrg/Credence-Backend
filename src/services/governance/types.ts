export type DisputeStatus =
  | 'pending'
  | 'under_review'
  | 'resolved'
  | 'dismissed'
  | 'expired'

export interface Dispute {
  id: string
  filedBy: string
  respondent: string
  reason: string
  evidence: string[]
  status: DisputeStatus
  createdAt: Date
  deadline: Date
  resolution: string | null
}

export interface DisputeInput {
  filedBy: string
  respondent: string
  reason: string
  evidence: string[]
  deadlineMs: number // duration from now, in milliseconds
}

export interface Vote {
  proposalId: string
  voter: string
  weight: number
  inFavor: boolean
  castAt: Date
}

export interface VoteInput {
  proposalId: string
  voter: string
  weight: number
  inFavor: boolean
}

export interface VoteSummary {
  proposalId: string
  totalFor: number
  totalAgainst: number
  voterCount: number
  reachedThreshold: boolean
}

export interface ArbitrationEntry {
  id: string
  disputeId: string
  arbiter: string
  decision: string
  reasoning: string
  timestamp: Date
}

export interface ArbitrationInput {
  disputeId: string
  arbiter: string
  decision: string
  reasoning: string
}

export type MultisigStatus = 'pending' | 'executed' | 'cancelled' | 'expired'

export interface MultisigProposal {
  id: string
  signers: string[]
  requiredSignatures: number
  action: string
  signatures: Set<string>
  status: MultisigStatus
  createdAt: Date
  expiresAt: Date
}

export interface MultisigInput {
  signers: string[]
  requiredSignatures: number
  action: string
  ttlMs: number // time to live from now, in milliseconds
}
