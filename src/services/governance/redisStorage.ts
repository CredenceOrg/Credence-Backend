import type { Redis } from 'ioredis';
import { IProposalStorage } from './multisig.js';
import { MultisigProposal, MultisigStatus } from './types.js';

// We need a serialized version of MultisigProposal because Maps and Sets don't
// JSON serialize automatically.
interface SerializedProposal {
  id: string;
  signers: string[];
  requiredSignatures: number;
  action: string;
  signatures: Array<[string, string]>; // Array of entries instead of Map
  slashingVotes: string[]; // Array instead of Set
  payload?: any;
  status: MultisigStatus;
  createdAt: string; // ISO string
  expiresAt: string; // ISO string
}

export class RedisProposalStorage implements IProposalStorage {
  private readonly PREFIX = 'governance:proposal:';

  constructor(private redis: Redis) {}

  public async saveProposal(proposal: MultisigProposal): Promise<void> {
    const key = this.getKey(proposal.id);
    const serialized = this.serialize(proposal);
    
    // Buffer to keep records around after expiration
    const ttlSeconds = Math.floor((proposal.expiresAt.getTime() - Date.now()) / 1000) + 86400;

    await this.redis.set(key, JSON.stringify(serialized), 'EX', Math.max(0, ttlSeconds));
  }

  public async getProposal(id: string): Promise<MultisigProposal | undefined> {
    const key = this.getKey(id);
    const data = await this.redis.get(key);

    if (!data) {
      return undefined;
    }

    const serialized: SerializedProposal = JSON.parse(data);
    return this.deserialize(serialized);
  }

  public async updateProposal(proposal: MultisigProposal): Promise<void> {
    const key = this.getKey(proposal.id);
    const ttlSeconds = Math.floor((proposal.expiresAt.getTime() - Date.now()) / 1000) + 86400; 

    if (ttlSeconds > 0) {
      await this.redis.set(key, JSON.stringify(this.serialize(proposal)), 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, JSON.stringify(this.serialize(proposal)), 'EX', 3600);
    }
  }

  private getKey(id: string): string {
    return `${this.PREFIX}${id}`;
  }

  private serialize(proposal: MultisigProposal): SerializedProposal {
    return {
      ...proposal,
      signatures: Array.from(proposal.signatures.entries()),
      slashingVotes: Array.from(proposal.slashingVotes),
      createdAt: proposal.createdAt.toISOString(),
      expiresAt: proposal.expiresAt.toISOString(),
    };
  }

  private deserialize(serialized: SerializedProposal): MultisigProposal {
    return {
      ...serialized,
      signatures: new Map(serialized.signatures),
      slashingVotes: new Set(serialized.slashingVotes),
      createdAt: new Date(serialized.createdAt),
      expiresAt: new Date(serialized.expiresAt),
    };
  }
}
