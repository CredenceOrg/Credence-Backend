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
   * Fetches all identities (Used for the GET /api/identities debugging route)
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
      // This is where the magic happens: if the DB version != expectedVersion, we throw
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
    // Basic Stellar G-address validation (starts with G, 56 chars)
    return /^G[A-Z2-7]{55}$/.test(address);
  }

  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// --- INITIALIZATION ---
// We create the repository instance first
const identitiesRepository = new IdentitiesRepository();

// Then we export the service instance for the routes to use
export const identityService = new IdentityService(identitiesRepository);