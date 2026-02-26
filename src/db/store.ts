/**
 * In-memory identity store.
 * In production, replace with a PostgreSQL/Redis-backed implementation.
 */

export interface Identity {
  address: string
  /** Bond amount in wei (or smallest unit). */
  bondedAmount: string
  /** ISO 8601 timestamp when the bond was first posted, or null if unbonded. */
  bondStart: string | null
  attestationCount: number
  /** Arbitrary key/value fields the identity has attested to. */
  agreedFields?: Record<string, string>
}

const store = new Map<string, Identity>()

// Seed data – representative identities used in development and tests.
const seeds: Identity[] = [
  {
    address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    bondedAmount: '1000000000000000000', // 1 ETH
    bondStart: '2024-01-15T00:00:00.000Z',
    attestationCount: 5,
    agreedFields: { name: 'Alice', role: 'validator' },
  },
  {
    address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    bondedAmount: '500000000000000000', // 0.5 ETH
    bondStart: '2024-06-01T00:00:00.000Z',
    attestationCount: 2,
  },
  {
    address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
    bondedAmount: '0',
    bondStart: null,
    attestationCount: 0,
  },
  {
    address: '0x742d35cc6634c0532925a3b844bc454e4438f44e',
    bondedAmount: '0',
    bondStart: null,
    attestationCount: 0,
  },
]

for (const seed of seeds) {
  store.set(seed.address.toLowerCase(), seed)
}

export function getIdentity(address: string): Identity | undefined {
  return store.get(address.toLowerCase())
}

export function setIdentity(identity: Identity): void {
  store.set(identity.address.toLowerCase(), identity)
}

export function hasIdentity(address: string): boolean {
  return store.has(address.toLowerCase())
}
