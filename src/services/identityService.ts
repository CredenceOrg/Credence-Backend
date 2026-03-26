import { randomBytes } from 'crypto'; // Added for secure key generation
import { IdentitiesRepository, Identity } from '../repositories/identities.repository.js';

/**
 * Custom error for version conflicts in optimistic locking
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Identity verification result for a single address
 */
export interface IdentityVerification {
  address: string
  trustScore: number
  bondStatus: {
    bondedAmount: string
    bondStart: string | null
    bondDuration: number | null
    active: boolean
  }
  attestationCount: number
  lastUpdated: string
  version?: number 
}

export interface VerificationError {
  address: string
  error: string
  message: string
}

export class IdentityService {
  private repo: IdentitiesRepository;

  constructor(repo: IdentitiesRepository) {
    this.repo = repo;
  }

  /**
   * ISSUE #130: Generates a new secure API key and rotates it in the database.
   */
  async rotateIdentityApiKey(id: number): Promise<Identity> {
    // Generate a secure 32-character hex key (16 bytes)
    const newKey = `cred_${randomBytes(16).toString('hex')}`;

    const success = this.repo.updateApiKey(id, newKey);

    if (!success) {
      throw new Error(`Rotation failed: Identity with ID ${id} not found.`);
    }

    const updatedIdentity = this.repo.findById(id);
    if (!updatedIdentity) throw new Error('Failed to retrieve identity after rotation');
    
    return updatedIdentity;
  }

  /**
   * Fetches all identities
   */
  async getAllIdentities(): Promise<Identity[]> {
    return this.repo.findAll();
  }

  /**
   * Updates an identity address with optimistic locking.
   */
  async updateIdentityAddress(id: number, expectedVersion: number, newAddress: string): Promise<Identity> {
    if (!this.isValidStellarAddress(newAddress)) {
      throw new Error('Invalid Stellar address format');
    }

    const updated = this.repo.updateWithLock(id, expectedVersion, newAddress);

    if (!updated) {
      throw new ConflictError(
        `Update failed: The profile (ID: ${id}) was modified by another session. Please refresh and try again.`
      );
    }

    return updated;
  }

  /**
   * Verify a single address
   */
  async verifyIdentity(address: string): Promise<IdentityVerification> {
    if (!this.isValidStellarAddress(address)) {
      throw new Error('Invalid Stellar address format');
    }

    const identity = this.repo.findByAddress(address);
    await this.simulateDelay(10);

    const hasBond = Math.random() > 0.5;
    return {
      address,
      trustScore: Math.floor(Math.random() * 100),
      bondStatus: {
        bondedAmount: hasBond ? (Math.random() * 10000).toFixed(2) : '0',
        bondStart: hasBond ? new Date(Date.now() - 86400000 * 30).toISOString() : null,
        bondDuration: hasBond ? 365 : null,
        active: hasBond,
      },
      attestationCount: Math.floor(Math.random() * 50),
      lastUpdated: new Date().toISOString(),
      version: identity?.version 
    };
  }

  private isValidStellarAddress(address: string): boolean {
    return /^G[A-Z2-7]{55}$/.test(address);
  }

  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// --- INITIALIZATION ---
// Ensure we pass the DB instance correctly if needed, 
// or let the route handler handle the dependency injection.
import Database from 'better-sqlite3';
const db = new Database('src/db/identities.db'); 

export const identityService = new IdentityService(new IdentitiesRepository(db));