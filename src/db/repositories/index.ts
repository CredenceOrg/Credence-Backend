export * from "./baseRepository.js";
export * from "./attestationsRepository.js";
export * from "./auditLogsRepository.js";
export * from "./bondsRepository.js";
export * from "./identitiesRepository.js";
export * from "./scoreHistoryRepository.js";
export * from "./slashEventsRepository.js";
export * from "./failedInboundEventsRepository.js";
export * from "./reportRepository.js";
export * from "./settlementsRepository.js";
export * from "./idempotencyRepository.js";
export * from "./webhookRepository.js";
export * from "./walletsRepository.js";
export * from "./walletTransactionsRepository.js";

export interface Identity {
  /** Surrogate UUID primary key. */
  id: string;
  /** Blockchain wallet address (unique). */
  address: string;
  /** ISO-8601 timestamp when first registered. */
  createdAt: Date;
  /** ISO-8601 timestamp of the most recent update. */
  updatedAt: Date;
}

/** Row shape for the `bonds` table. */
export interface Bond {
  /** Surrogate UUID primary key. */
  id: string;
  /** FK → identities.id */
  identityId: string;
  /** Total amount bonded (string to preserve 18-decimal precision). */
  bondedAmount: string;
  /** When the bond period began. */
  bondStart: Date;
  /** PostgreSQL INTERVAL string, e.g. "30 days". */
  bondDuration: string;
  /** Computed: bond_start + bond_duration (stored column). */
  bondEnd: Date;
  /** Cumulative slashed amount. */
  slashedAmount: string;
  /** Whether the bond is still active. */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Input / DTO types
// ---------------------------------------------------------------------------

/** Fields required to register a new identity. */
export interface CreateIdentityInput {
  address: string;
}

/** Fields required to create a new bond. */
export interface CreateBondInput {
  identityId: string;
  bondedAmount: string;
  /** PostgreSQL INTERVAL string, e.g. "30 days" or "6 months". */
  bondDuration: string;
  /** Defaults to NOW() when omitted. */
  bondStart?: Date;
}

/** Partial update payload for a bond. */
export interface UpdateBondInput {
  slashedAmount?: string;
  active?: boolean;
}

export type SettlementStatus = "pending" | "settled" | "failed";

/** Row shape for the `settlements` table. */
export interface SettlementRecord {
  id: string;
  bondId: string;
  amount: string;
  transactionHash: string;
  settledAt: Date;
  status: SettlementStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields required to create or upsert a settlement. */
export interface CreateSettlementInput {
  bondId: string;
  amount: string;
  transactionHash: string;
  settledAt?: Date;
  status?: SettlementStatus;
}
