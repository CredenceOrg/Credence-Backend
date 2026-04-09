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

export type MultisigStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'cancelled' | 'expired'

export interface MultisigProposal {
  id: string
  signers: string[]
  requiredSignatures: number
  /** The action to be performed (e.g. 'slash_validator', 'distribute_rewards') */
  action: string
  /** Signatures from authorized signers: Map<signer_id, signature_token> */
  signatures: Map<string, string>
  /** Set of voter IDs who voted for slashing the proposal itself or associated entity */
  slashingVotes: Set<string>
  /** Optional data payload for the action */
  payload?: any
  status: MultisigStatus
  createdAt: Date
  expiresAt: Date
}

export interface MultisigInput {
  signers: string[]
  requiredSignatures: number
  action: string
  payload?: any
  ttlMs: number // time to live from now, in milliseconds
}
