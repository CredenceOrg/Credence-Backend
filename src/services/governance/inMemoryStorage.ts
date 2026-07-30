import { IProposalStorage } from './multisig.js';
import { MultisigProposal } from './types.js';

/**
 * An in-memory implementation of IProposalStorage suitable for testing.
 */
export class InMemoryProposalStorage implements IProposalStorage {
  private proposals: Map<string, MultisigProposal> = new Map();

  public async saveProposal(proposal: MultisigProposal): Promise<void> {
    this.proposals.set(proposal.id, proposal);
  }

  public async getProposal(id: string): Promise<MultisigProposal | undefined> {
    return this.proposals.get(id);
  }

  public async updateProposal(proposal: MultisigProposal): Promise<void> {
    this.proposals.set(proposal.id, proposal);
  }
}
