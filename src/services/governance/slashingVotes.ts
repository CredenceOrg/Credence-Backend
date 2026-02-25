import { randomBytes } from 'crypto'

export type VoteChoice = 'approve' | 'reject'
export type SlashRequestStatus = 'pending' | 'approved' | 'rejected'

export interface Vote {
  voterId: string
  choice: VoteChoice
  timestamp: Date
}

export interface SlashRequest {
  id: string
  /** On-chain address of the entity being slashed */
  targetAddress: string
  reason: string
  requestedBy: string
  createdAt: Date
  votes: Vote[]
  status: SlashRequestStatus
  /** Number of approve votes required to reach threshold */
  threshold: number
  /** Total number of eligible signers */
  totalSigners: number
}

export interface CreateSlashRequestInput {
  targetAddress: string
  reason: string
  requestedBy: string
  /** Approve votes required to pass (default: 3) */
  threshold?: number
  /** Total eligible signers (default: 5) */
  totalSigners?: number
}

export interface VoteResult {
  slashRequestId: string
  voterId: string
  choice: VoteChoice
  approveCount: number
  rejectCount: number
  status: SlashRequestStatus
}

// In-memory store — replace with a DB adapter in production
const store = new Map<string, SlashRequest>()

const DEFAULT_THRESHOLD = 3
const DEFAULT_TOTAL_SIGNERS = 5

/**
 * Determine the outcome of a slash request based on current votes.
 * Approved when approve count >= threshold.
 * Rejected when remaining possible approve votes can no longer reach threshold.
 */
function computeStatus(req: SlashRequest): SlashRequestStatus {
  const approveCount = req.votes.filter((v) => v.choice === 'approve').length
  const rejectCount = req.votes.filter((v) => v.choice === 'reject').length

  if (approveCount >= req.threshold) return 'approved'

  // Remaining voters can't possibly reach threshold
  const remainingVoters = req.totalSigners - req.votes.length
  if (approveCount + remainingVoters < req.threshold) return 'rejected'

  // Explicit majority reject even before all votes are cast
  if (rejectCount > req.totalSigners - req.threshold) return 'rejected'

  return 'pending'
}

/**
 * Create a new slash request awaiting governance votes.
 *
 * @param input  Parameters for the slash request
 * @returns      The newly created slash request
 */
export function createSlashRequest(input: CreateSlashRequestInput): SlashRequest {
  const { targetAddress, reason, requestedBy, threshold, totalSigners } = input

  const resolvedThreshold = threshold ?? DEFAULT_THRESHOLD
  const resolvedTotal = totalSigners ?? DEFAULT_TOTAL_SIGNERS

  if (resolvedThreshold < 1) throw new Error('threshold must be >= 1')
  if (resolvedTotal < resolvedThreshold) {
    throw new Error('totalSigners must be >= threshold')
  }

  const req: SlashRequest = {
    id: randomBytes(8).toString('hex'),
    targetAddress,
    reason,
    requestedBy,
    createdAt: new Date(),
    votes: [],
    status: 'pending',
    threshold: resolvedThreshold,
    totalSigners: resolvedTotal,
  }

  store.set(req.id, req)
  return req
}

/**
 * Submit a vote (approve or reject) on a slash request.
 *
 * @param slashRequestId  ID of the slash request
 * @param voterId         Identifier of the voter
 * @param choice          'approve' or 'reject'
 * @returns               Updated vote counts and status, or null if request not found
 * @throws                Error if the request is already resolved or voter has already voted
 */
export function submitVote(
  slashRequestId: string,
  voterId: string,
  choice: VoteChoice,
): VoteResult | null {
  const req = store.get(slashRequestId)
  if (!req) return null

  if (req.status !== 'pending') {
    throw new Error(`Slash request is already ${req.status}`)
  }

  const alreadyVoted = req.votes.some((v) => v.voterId === voterId)
  if (alreadyVoted) {
    throw new Error(`Voter ${voterId} has already voted on this request`)
  }

  req.votes.push({ voterId, choice, timestamp: new Date() })
  req.status = computeStatus(req)

  const approveCount = req.votes.filter((v) => v.choice === 'approve').length
  const rejectCount = req.votes.filter((v) => v.choice === 'reject').length

  return {
    slashRequestId: req.id,
    voterId,
    choice,
    approveCount,
    rejectCount,
    status: req.status,
  }
}

/**
 * Retrieve a slash request by ID.
 *
 * @param id  Slash request ID
 * @returns   The slash request, or null if not found
 */
export function getSlashRequest(id: string): SlashRequest | null {
  return store.get(id) ?? null
}

/**
 * List all slash requests, optionally filtered by status.
 *
 * @param status  Optional status filter
 * @returns       Array of matching slash requests
 */
export function listSlashRequests(status?: SlashRequestStatus): SlashRequest[] {
  const all = [...store.values()]
  return status ? all.filter((r) => r.status === status) : all
}

/** Reset the in-memory store. Intended for use in tests only. */
export function _resetStore(): void {
  store.clear()
}
