import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { MultisigProposal, MultisigInput, MultisigStatus } from './types.js';

export interface IProposalStorage {
  saveProposal(proposal: MultisigProposal): Promise<void>;
  getProposal(id: string): Promise<MultisigProposal | undefined>;
  updateProposal(proposal: MultisigProposal): Promise<void>;
}

export class MultiSigCoordinationService extends EventEmitter {
  constructor(private storage: IProposalStorage) {
    super();
  }

  /**
   * Creates a new multi-sig proposal.
   * @param input Proposal parameters including signers, required count, and action
   * @returns The newly created proposal
   */
  public async createProposal(input: MultisigInput): Promise<MultisigProposal> {
    const id = randomUUID();
    const now = new Date();

    if (!input.signers || input.signers.length < 2) {
      throw new Error('At least 2 signers are required');
    }

    if (input.requiredSignatures < 1 || input.requiredSignatures > input.signers.length) {
      throw new Error('requiredSignatures must be between 1 and the number of signers');
    }

    const proposal: MultisigProposal = {
      id,
      signers: [...input.signers],
      requiredSignatures: input.requiredSignatures,
      action: input.action,
      payload: input.payload,
      signatures: new Map(),
      slashingVotes: new Set(),
      status: 'pending',
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.ttlMs),
    };

    await this.storage.saveProposal(proposal);
    this.emit('proposalCreated', proposal);
    return proposal;
  }

  /**
   * Retrieves a proposal by ID.
   * @param id Proposal ID
   * @returns The proposal or undefined
   */
  public async getProposal(id: string): Promise<MultisigProposal | undefined> {
    const proposal = await this.storage.getProposal(id);
    if (proposal) {
      await this.checkExpiration(proposal);
    }
    return proposal;
  }

  /**
   * Submits a signature for a proposal.
   * @param id Proposal ID
   * @param signer The address/ID of the signer
   * @param signature The cryptographic signature or approval token
   * @returns Updated proposal
   */
  public async submitSignature(id: string, signer: string, signature: string): Promise<MultisigProposal> {
    const proposal = await this.getProposalOrThrow(id);
    
    await this.checkExpiration(proposal);

    if (proposal.status !== 'pending') {
      throw new Error(`Cannot sign proposal in status ${proposal.status}`);
    }

    if (!proposal.signers.includes(signer)) {
      throw new Error(`Signer ${signer} is not authorized for proposal ${id}`);
    }

    if (proposal.signatures.has(signer)) {
      throw new Error(`Signer ${signer} has already signed proposal ${id}`);
    }

    proposal.signatures.set(signer, signature);
    this.emit('signatureSubmitted', { id, signer, signature });

    if (proposal.signatures.size >= proposal.requiredSignatures) {
      proposal.status = 'approved';
      this.emit('proposalApproved', proposal);
    }

    await this.storage.updateProposal(proposal);
    return proposal;
  }

  /**
   * Records a slashing vote against a proposal or associated target.
   * @param id Proposal ID
   * @param voter The address/ID of the voter
   */
  public async addSlashingVote(id: string, voter: string): Promise<void> {
    const proposal = await this.getProposalOrThrow(id);
    await this.checkExpiration(proposal);

    if (proposal.slashingVotes.has(voter)) {
      throw new Error(`Voter ${voter} has already submitted a slashing vote`);
    }

    proposal.slashingVotes.add(voter);
    await this.storage.updateProposal(proposal);
    
    this.emit('slashingVoteAdded', { id, voter });
    
    // Potential logic: if slashing votes exceed a threshold, reject the proposal
    if (proposal.slashingVotes.size >= Math.ceil(proposal.signers.length / 2)) {
        await this.rejectProposal(id, 'Slashing threshold reached');
    }
  }

  /**
   * Executes an approved proposal.
   * @param id Proposal ID
   * @returns The result of the execution (the payload)
   */
  public async executeProposal(id: string): Promise<any> {
    const proposal = await this.getProposalOrThrow(id);

    if (proposal.status !== 'approved') {
      throw new Error(`Cannot execute proposal in status ${proposal.status}`);
    }

    proposal.status = 'executed';
    await this.storage.updateProposal(proposal);
    
    this.emit('proposalExecuted', proposal);

    return proposal.payload;
  }
  
  /**
   * Rejects a proposal explicitly.
   * @param id Proposal ID
   * @param reason The reason for rejection
   */
  public async rejectProposal(id: string, reason: string): Promise<void> {
    const proposal = await this.getProposalOrThrow(id);
    
    if (proposal.status !== 'pending' && proposal.status !== 'approved') {
      throw new Error(`Cannot reject proposal in status ${proposal.status}`);
    }
    
    proposal.status = 'rejected';
    await this.storage.updateProposal(proposal);
    
    this.emit('proposalRejected', { id, reason, proposal });
  }

  /**
   * Helper to get a proposal or throw if not found.
   */
  private async getProposalOrThrow(id: string): Promise<MultisigProposal> {
    const proposal = await this.storage.getProposal(id);
    if (!proposal) {
      throw new Error(`Proposal ${id} not found`);
    }
    return proposal;
  }

  /**
   * Helper to check if a proposal is expired and update status if so.
   */
  private async checkExpiration(proposal: MultisigProposal): Promise<void> {
    if (proposal.status === 'pending' && new Date() > proposal.expiresAt) {
      proposal.status = 'expired';
      await this.storage.updateProposal(proposal);
      this.emit('proposalExpired', { id: proposal.id });
    }
  }
}
