import type { RawSlashEvent, SlashEvent, SlashEventStore, ScoreTrigger } from './slashTypes.js'

/**
 * Source of slash events (subscribe or poll).
 * Implement with your chain client (e.g. Horizon subscription or polling).
 */
export interface SlashEventSource {
  /** Subscribe to new slash events. Handler is called for each event. */
  subscribe(handler: (event: SlashEvent) => Promise<void> | void): void | (() => void)
  /** Optional: poll for events once. Use for testing or batch sync. */
  poll?(): Promise<SlashEvent[]>
}

/**
 * Parses a raw contract/Horizon event into a SlashEvent.
 * Override or replace for your event shape (e.g. ethers EventLog).
 *
 * @param raw - Raw event (e.g. { identity: string, amount: bigint, reason: string, evidenceRef?: string })
 * @returns Parsed SlashEvent, or null if invalid
 */
export function parseSlashEvent(raw: RawSlashEvent): SlashEvent | null {
  const identity = raw.identity ?? raw.identityAddress ?? raw.account
  const amount = raw.amount ?? raw.slashedAmount ?? raw.value
  const reason = raw.reason ?? raw.slashReason ?? ''
  if (typeof identity !== 'string' || identity === '') return null
  const amountStr =
    typeof amount === 'bigint'
      ? amount.toString()
      : typeof amount === 'number'
        ? String(amount)
        : typeof amount === 'string'
          ? amount
          : null
  if (amountStr === null) return null
  const evidenceRef =
    typeof raw.evidenceRef === 'string'
      ? raw.evidenceRef
      : typeof raw.evidence === 'string'
        ? raw.evidence
        : undefined
  const timestamp =
    typeof raw.timestamp === 'number'
      ? raw.timestamp
      : typeof raw.blockNumber === 'number'
        ? raw.blockNumber
        : undefined
  return {
    identity,
    amount: amountStr,
    reason: typeof reason === 'string' ? reason : '',
    ...(evidenceRef !== undefined && { evidenceRef }),
    ...(timestamp !== undefined && { timestamp }),
  }
}

/**
 * Horizon listener for slashing events: detects slash events, records in DB,
 * updates bond slashed_amount, and optionally triggers score recalculation.
 */
export class HorizonSlashListener {
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly source: SlashEventSource,
    private readonly store: SlashEventStore,
    private readonly scoreTrigger?: ScoreTrigger
  ) {}

  /**
   * Start listening: subscribe to slash events and process each (insert, update bond, trigger score).
   */
  start(): void {
    if (this.unsubscribe) return
    const unsub = this.source.subscribe((event) => this.handleEvent(event))
    this.unsubscribe = typeof unsub === 'function' ? unsub : () => {}
  }

  /**
   * Stop listening (e.g. on shutdown).
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  /**
   * Process one slash event: insert into slash_events, add to bond slashed_amount, trigger score.
   * @param event - Parsed slash event (identity, amount, reason, evidenceRef)
   */
  async handleEvent(event: SlashEvent): Promise<void> {
    await this.store.insertSlashEvent(event)
    await this.store.addSlashedAmountToBond(event.identity, event.amount)
    if (this.scoreTrigger) {
      await this.scoreTrigger.trigger(event.identity)
    }
  }

  /**
   * Process a raw event: parse then handle. Use when events come in raw form.
   * @param raw - Raw contract/Horizon event (see parseSlashEvent for supported shapes)
   * @returns true if parsed and processed, false if invalid
   */
  async handleRawEvent(raw: RawSlashEvent): Promise<boolean> {
    const event = parseSlashEvent(raw)
    if (!event) return false
    await this.handleEvent(event)
    return true
  }

  /**
   * Poll once for events (if source supports it), process each.
   * @returns Number of events processed (0 if source has no poll)
   */
  async pollOnce(): Promise<number> {
    if (!this.source.poll) return 0
    const events = await this.source.poll()
    for (const event of events) {
      await this.handleEvent(event)
    }
    return events.length
  }
}

/**
 * Create a Horizon slashing listener.
 *
 * @param source - Subscribe or poll for slash events
 * @param store - Insert slash_events and update bond slashed_amount
 * @param scoreTrigger - Optional: trigger score recalculation or snapshot
 */
export function createHorizonSlashListener(
  source: SlashEventSource,
  store: SlashEventStore,
  scoreTrigger?: ScoreTrigger
): HorizonSlashListener {
  return new HorizonSlashListener(source, store, scoreTrigger)
}
