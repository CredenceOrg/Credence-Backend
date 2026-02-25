import { randomUUID } from 'node:crypto'
import type { MultisigProposal, MultisigInput } from './types.js'

const store = new Map<string, MultisigProposal>()

const MIN_SIGNERS = 2
const MAX_SIGNERS = 20
const MIN_TTL_MS = 60 * 60 * 1000 // 1 hour

export function resetStore(): void {
  store.clear()
}

export function createProposal(input: MultisigInput): MultisigProposal {
  if (!Array.isArray(input.signers) || input.signers.length < MIN_SIGNERS) {
    throw new Error(`At least ${MIN_SIGNERS} signers are required`)
  }
  if (input.signers.length > MAX_SIGNERS) {
    throw new Error(`Cannot exceed ${MAX_SIGNERS} signers`)
  }

  const unique = new Set(input.signers)
  if (unique.size !== input.signers.length) {
    throw new Error('Duplicate signers are not allowed')
  }

  if (
    typeof input.requiredSignatures !== 'number' ||
    input.requiredSignatures < 1 ||
    input.requiredSignatures > input.signers.length
  ) {
    throw new Error('requiredSignatures must be between 1 and the number of signers')
  }

  if (!input.action || typeof input.action !== 'string') {
    throw new Error('action is required')
  }

  if (typeof input.ttlMs !== 'number' || input.ttlMs < MIN_TTL_MS) {
    throw new Error(`ttlMs must be at least ${MIN_TTL_MS}ms`)
  }

  const now = new Date()
  const proposal: MultisigProposal = {
    id: randomUUID(),
    signers: [...input.signers],
    requiredSignatures: input.requiredSignatures,
    action: input.action,
    signatures: new Set(),
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + input.ttlMs),
  }

  store.set(proposal.id, proposal)
  return proposal
}

export function getProposal(id: string): MultisigProposal | undefined {
  return store.get(id)
}

export function addSignature(proposalId: string, signer: string): MultisigProposal {
  const proposal = store.get(proposalId)
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`)

  if (proposal.status !== 'pending') {
    throw new Error(`Cannot sign a proposal in "${proposal.status}" state`)
  }

  if (new Date() > proposal.expiresAt) {
    proposal.status = 'expired'
    throw new Error('Proposal has expired')
  }

  if (!proposal.signers.includes(signer)) {
    throw new Error(`${signer} is not an authorized signer for this proposal`)
  }

  if (proposal.signatures.has(signer)) {
    throw new Error(`${signer} has already signed this proposal`)
  }

  proposal.signatures.add(signer)
  return proposal
}

export function removeSignature(proposalId: string, signer: string): MultisigProposal {
  const proposal = store.get(proposalId)
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`)

  if (proposal.status !== 'pending') {
    throw new Error(`Cannot modify a proposal in "${proposal.status}" state`)
  }

  if (!proposal.signatures.has(signer)) {
    throw new Error(`${signer} has not signed this proposal`)
  }

  proposal.signatures.delete(signer)
  return proposal
}

export function executeIfReady(proposalId: string): MultisigProposal {
  const proposal = store.get(proposalId)
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`)

  if (proposal.status !== 'pending') {
    throw new Error(`Cannot execute a proposal in "${proposal.status}" state`)
  }

  if (new Date() > proposal.expiresAt) {
    proposal.status = 'expired'
    throw new Error('Proposal has expired')
  }

  if (proposal.signatures.size < proposal.requiredSignatures) {
    throw new Error(
      `Not enough signatures: ${proposal.signatures.size}/${proposal.requiredSignatures}`,
    )
  }

  proposal.status = 'executed'
  return proposal
}

export function cancelProposal(proposalId: string): MultisigProposal {
  const proposal = store.get(proposalId)
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`)

  if (proposal.status === 'executed') {
    throw new Error('Cannot cancel an executed proposal')
  }
  if (proposal.status === 'cancelled') {
    throw new Error('Proposal is already cancelled')
  }

  proposal.status = 'cancelled'
  return proposal
}

export function getStatus(proposalId: string): MultisigProposal['status'] {
  const proposal = store.get(proposalId)
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`)

  // Lazily transition to expired
  if (proposal.status === 'pending' && new Date() > proposal.expiresAt) {
    proposal.status = 'expired'
  }

  return proposal.status
}
