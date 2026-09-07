/**
 * Horizon Bond Creation Listener
 * Single stream with bounded exponential-backoff-with-jitter reconnect.
 * @module horizonBondEvents
 */

import { Horizon } from '@stellar/stellar-sdk'
import type { Pool, PoolClient } from 'pg'
import { upsertIdentity, upsertBond, upsertCursor } from '../services/identityService.js'
import { pool as defaultPool } from '../db/pool.js'
import { CursorRepository } from '../db/repositories/cursorRepository.js'
import { HorizonEventLedger } from '../db/repositories/horizonEventRepository.js'
import {
  computeStateHash,
  stateFromBondEvent,
  extractLedgerSeq,
  type BondCreationEventPayload,
} from '../services/horizonParity.js'
import { register, Gauge } from 'prom-client'
import { BoundedBackoff } from '../utils/backoff.js'
import { getHorizonMetrics } from '../observability/horizonMetrics.js'
import { bondOperationSchema, DlqRouter, DlqReasonCode, validateAndRoute } from './messageValidator.js'

/**
 * Thrown when the same event ID arrives with a materially different payload
 * than the previously-recorded event.  This signals a conflicting reuse of
 * the durable request key and must be rejected deterministically — the
 * original event's state remains correct.
 *
 * @see resolveConflictingEvent
 */
export class ConflictingEventError extends Error {
  public readonly code = 'CONFLICTING_EVENT'
  public readonly eventId: string
  public readonly streamName: string
  public readonly existingPayload: Record<string, unknown>
  public readonly incomingPayload: Record<string, unknown>

  constructor(params: {
    eventId: string
    streamName: string
    existingPayload: Record<string, unknown>
    incomingPayload: Record<string, unknown>
  }) {
    super(
      `Conflicting event: ${params.streamName}:${params.eventId} has already been recorded with a different payload. ` +
      `The incoming event is rejected to preserve the original committed state.`,
    )
    this.name = 'ConflictingEventError'
    this.eventId = params.eventId
    this.streamName = params.streamName
    this.existingPayload = params.existingPayload
    this.incomingPayload = params.incomingPayload
  }
}

/**
 * Determine whether an already-recorded event conflicts with an incoming
 * event that carries the same event ID.
 *
 * Two events are **conflicting** when they share an event ID but have
 * materially different payloads.  Insignificant differences (e.g. extra
 * metadata fields added by the provider) are tolerated; only core field
 * differences (identity id, bond id, bond amount, bond duration) are
 * compared.
 *
 * @returns `null` when the events are identical or when no existing record
 *   is found; a `ConflictingEventError` when a material conflict is detected.
 */
export function resolveConflictingEvent(
  streamName: string,
  eventId: string,
  existingPayload: Record<string, unknown>,
  incomingPayload: Record<string, unknown>,
): ConflictingEventError | null {
  const coreFields = ['source_account', 'id', 'amount', 'duration'] as const
  for (const field of coreFields) {
    if (
      field in existingPayload &&
      field in incomingPayload &&
      String((existingPayload as any)[field]) !== String((incomingPayload as any)[field])
    ) {
      return new ConflictingEventError({
        eventId,
        streamName,
        existingPayload,
        incomingPayload,
      })
    }
  }
  return null
}

export interface BondCreationHandle {
  stop: () => void;
}

const HORIZON_URL = process.env.HORIZON_URL || "https://horizon.stellar.org";
const server = new Horizon.Server(HORIZON_URL);
const STREAM_NAME = "bond_creation";

const cursorLagGauge = new Gauge({
  name: "horizon_listener_cursor_lag_seconds",
  help: "Time elapsed since last Horizon cursor checkpoint",
  labelNames: ["stream_name"],
  registers: [register],
});

const lastCheckpointGauge = new Gauge({
  name: "horizon_listener_last_checkpoint_timestamp",
  help: "Unix timestamp of last Horizon cursor checkpoint",
  labelNames: ["stream_name"],
  registers: [register],
});

/**
 * Subscribe to bond creation events from Horizon.
 * Opens exactly ONE stream. On error, reconnects with bounded
 * exponential-backoff-with-jitter (default: 500 ms base, 30 s cap).
 *
 * Invalid payloads are quarantined to the DLQ via `DlqRouter` and the
 * cursor is NOT advanced past them, so they can be inspected and replayed.
 *
 * Every committed transition writes a versioned, complete record to the
 * `horizon_events` ledger (`eventLedger`) inside the SAME transaction as
 * the identity/bond mutation and cursor checkpoint.  A record therefore
 * only ever exists for a committed transition, keyed by the Horizon
 * operation id (correlation identifier) and carrying a deterministic hash
 * of the resulting identity state for parity reconciliation (issue #1266).
 */
export function subscribeBondCreationEvents(
  dlqRouter: DlqRouter,
  onEvent?: (event: {
    identity: { id: string };
    bond: { id: string; address: string; amount: string; duration: string | null };
  }) => void,
  pool: Pool = defaultPool,
  eventLedger: HorizonEventLedger = new HorizonEventLedger(pool),
): BondCreationHandle {
  const cursorRepo = new CursorRepository(pool);
  const backoff = new BoundedBackoff({ baseMs: 500, maxMs: 30_000 });
  const metrics = getHorizonMetrics();
  let cursor = "now";
  let activeStream: { close?: () => void } | undefined;
  let stopped = false;

  const startStream = () => {
    if (stopped) return;

    metrics.streamUp.set({ stream: STREAM_NAME }, 1);

    activeStream = (server.operations() as any)
      .forAsset("BOND")
      .cursor(cursor)
      .stream({
        onmessage: async (op: any) => {
          const newCursor = op.paging_token;
          try {
            if (op.type === "create_bond") {
              const validation = await validateAndRoute(
                bondOperationSchema,
                STREAM_NAME,
                op,
                dlqRouter,
              );
              if (!validation.valid) {
                return;
              }
              const event = parseBondEvent(validation.data);
              // The event mutation, the versioned ledger record, and the
              // checkpoint are ONE durable unit. If a process crashes before
              // COMMIT, the next owner replays the event from the previous
              // cursor; it can never acknowledge an event whose state was only
              // partially persisted, and it can never leave a ledger record
              // for a transition that was not committed (issue #1266).
              const eventPayload = event as unknown as BondCreationEventPayload
              const ledgerInput = {
                streamName: STREAM_NAME,
                eventId: validation.data.id,
                pagingToken: newCursor,
                ledgerSeq: extractLedgerSeq(newCursor),
                eventType: 'create_bond',
                payload: event as unknown as Record<string, unknown>,
                stateHash: computeStateHash(stateFromBondEvent(eventPayload)),
              };
              const client: PoolClient = await pool.connect();
              try {
                await client.query('BEGIN');

                // Check for a previously-recorded event with the same ID.
                // If one exists, verify the payloads match (conflicting-key
                // detection) and, if identical, skip the business logic
                // entirely — a replay is a safe no-op.
                const existingRecord = await eventLedger.findByStreamAndEvent(
                  STREAM_NAME,
                  validation.data.id,
                );
                if (existingRecord) {
                  const conflict = resolveConflictingEvent(
                    STREAM_NAME,
                    validation.data.id,
                    existingRecord.payload,
                    event as unknown as Record<string, unknown>,
                  );
                  if (conflict) {
                    // Conflicting event: same ID, materially different
                    // payload.  Reject deterministically — the original
                    // event's state must not be overwritten.
                    await client.query('ROLLBACK');
                    throw conflict;
                  }
                  // Identical replay: skip business logic but still
                  // advance the cursor so the stream makes progress.
                  await upsertCursor({ streamName: STREAM_NAME, pagingToken: newCursor }, client);
                  await client.query('COMMIT');
                  cursor = newCursor;
                  updateMetrics(cursorRepo);
                  console.log(`[${STREAM_NAME}] Replay of event ${op.id} (identical payload), cursor: ${newCursor}`);
                  backoff.reset();
                  return;
                }

                // First time seeing this event: apply business logic and
                // record atomically.  `eventLedger.record()` uses
                // ON CONFLICT DO NOTHING, so a concurrent insert (from a
                // second listener replica) is a harmless no-op.
                await upsertIdentity(event.identity, client);
                await upsertBond(event.bond, client);
                await eventLedger.record(ledgerInput, client);
                await upsertCursor({ streamName: STREAM_NAME, pagingToken: newCursor }, client);
                await client.query('COMMIT');
              } catch (transactionError) {
                await client.query('ROLLBACK');
                throw transactionError;
              } finally {
                client.release();
              }
              cursor = newCursor;
              updateMetrics(cursorRepo);
              if (onEvent) onEvent(event);
              backoff.reset();
              console.log(`[${STREAM_NAME}] Processed event ${op.id}, cursor: ${newCursor}`);
            }
          } catch (err) {
            await dlqRouter.route(
              STREAM_NAME,
              op,
              DlqReasonCode.PROCESSING_ERROR,
              err instanceof Error ? err.message : String(err),
            );
            console.error(`[${STREAM_NAME}] Error processing event ${op.id}:`, err);
          }
        },
        onerror: async (err: unknown) => {
          console.error(`[${STREAM_NAME}] Horizon stream error:`, err);
          metrics.streamUp.set({ stream: STREAM_NAME }, 0);
          if (stopped) return;
          metrics.reconnectTotal.inc({ stream: STREAM_NAME });
          try {
            await backoff.wait();
            startStream();
          } catch (e: any) {
            if (e?.stopped || e?.exhausted) {
              console.warn(`[${STREAM_NAME}] Reconnect aborted:`, e);
            }
          }
        },
      });
  };

  const initAndStart = async () => {
    try {
      const savedCursor = await cursorRepo.findByStreamName(STREAM_NAME);
      if (savedCursor) {
        cursor = savedCursor.pagingToken;
        console.log(`[${STREAM_NAME}] Resuming from saved cursor: ${cursor}`);
      } else {
        console.log(`[${STREAM_NAME}] No saved cursor found, starting from: ${cursor}`);
      }
    } catch (err) {
      console.error(`[${STREAM_NAME}] Failed to load saved cursor, falling back to: ${cursor}`, err);
    }
    startStream();
  };

  // Start exactly ONE stream
  initAndStart();

  return {
    stop: () => {
      stopped = true;
      backoff.stop();
      metrics.streamUp.set({ stream: STREAM_NAME }, 0);
      if (activeStream?.close) activeStream.close();
    },
  };
}

function updateMetrics(cursorRepo: CursorRepository) {
  cursorRepo.getCursorLag(STREAM_NAME).then(lag => {
    if (lag !== null) cursorLagGauge.set({ stream_name: STREAM_NAME }, lag);
  }).catch(() => {});
  cursorRepo.findByStreamName(STREAM_NAME).then(cursor => {
    if (cursor) {
      lastCheckpointGauge.set(
        { stream_name: STREAM_NAME },
        Math.floor(cursor.lastCheckpoint.getTime() / 1000)
      );
    }
  }).catch(() => {});
}

function parseBondEvent(op: {
  source_account: string;
  id: string;
  amount: string;
  duration?: string | null;
}) {
  return {
    identity: { id: op.source_account },
    bond: {
      id: op.id,
      address: op.source_account,
      amount: op.amount,
      duration: op.duration ?? null,
    },
  };
}

// Re-export atomic implementation for backward compatibility
export { 
  subscribeBondCreationEventsAtomic,
  AtomicBondEventProcessor,
  type BondCreationEvent,
  type AtomicBondCreationHandle,
} from './horizonBondEvents.atomic.js'
