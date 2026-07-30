import client from 'prom-client'

/**
 * Counter for credits.low webhook events enqueued via the outbox.
 */
export const creditsLowEventsTotal = new client.Counter({
  name: 'credits_low_events_total',
  help: 'Total number of credits.low webhook events emitted when org credits cross the low-water threshold',
  registers: [client.register],
})

export function recordCreditsLowEvent(): void {
  creditsLowEventsTotal.inc()
}
