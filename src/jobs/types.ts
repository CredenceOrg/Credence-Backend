/**
 * Score snapshot for an identity at a point in time.
 */
export interface ScoreSnapshot {
  /** Identity address. */
  address: string
  /** Computed trust score. */
  score: number
  /** Bonded amount at snapshot time. */
  bondedAmount: string
  /** Attestation count at snapshot time. */
  attestationCount: number
  /** Timestamp when snapshot was taken (ISO string). */
  timestamp: string
}

/**
 * Identity data used for score computation.
 */
export interface IdentityData {
  /** Identity address. */
  address: string
  /** Current bonded amount. */
  bondedAmount: string
  /** Whether bond is active. */
  active: boolean
  /** Number of attestations received. */
  attestationCount: number
}

/**
 * Store for persisting score snapshots.
 */
export interface ScoreSnapshotStore {
  /** Save a score snapshot. */
  save(snapshot: ScoreSnapshot): Promise<void>
  /** Save multiple snapshots in batch. */
  saveBatch(snapshots: ScoreSnapshot[]): Promise<void>
}

/**
 * Data source for fetching identity data.
 */
export interface IdentityDataSource {
  /** Get all active identity addresses. */
  getActiveAddresses(): Promise<string[]>
  /** Get identity data for score computation. */
  getIdentityData(address: string): Promise<IdentityData | null>
}

/**
 * Score computation function.
 */
export type ScoreComputer = (data: IdentityData) => number

/**
 * Result of a snapshot job run.
 */
export interface SnapshotJobResult {
  /** Number of identities processed. */
  processed: number
  /** Number of snapshots saved. */
  saved: number
  /** Number of errors encountered. */
  errors: number
  /** Duration in milliseconds. */
  duration: number
  /** Timestamp when job started. */
  startTime: string
}
