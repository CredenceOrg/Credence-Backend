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
                await upsertIdentity(event.identity, client);
                await upsertBond(event.bond, client);
                // Idempotent: at-least-once replays of the same operation id
                // are no-ops, so repeated delivery never duplicates records.
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
