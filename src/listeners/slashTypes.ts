/**
 * Parsed slash event: identity, amount, reason, evidence ref.
 * Persisted in slash_events and used to update bond slashed_amount.
 */
export interface SlashEvent {
  /** Identity (e.g. wallet) address that was slashed. */
  identity: string
  /** Slashed amount as string (e.g. wei or token amount). */
  amount: string
  /** Reason or code for the slash. */
  reason: string
  /** Optional reference to evidence (e.g. IPFS hash, URL). */
  evidenceRef?: string
  /** Event timestamp (seconds) if available. */
  timestamp?: number
}

/**
 * Raw event from contract/Horizon before parsing.
 * Shape depends on your chain client; implement parseSlashEvent for your format.
 */
export interface RawSlashEvent {
  [key: string]: unknown
}

/**
 * Persistence for slash events and bond slashed_amount updates.
 * Implement over your DB (e.g. slash_events table + bond table).
 */
export interface SlashEventStore {
  /** Insert a slash event into slash_events. */
  insertSlashEvent(event: SlashEvent): Promise<void>
  /** Add amount to the bond's slashed_amount for the given identity. */
  addSlashedAmountToBond(identity: string, amount: string): Promise<void>
}

/**
 * Optional: trigger score recalculation or snapshot after a slash.
 * Implement with your reputation engine.
 */
export interface ScoreTrigger {
  /** Trigger recalculation or snapshot for an identity (or global). */
  trigger(identity: string): Promise<void>
}
