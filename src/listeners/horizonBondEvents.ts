/**
 * Horizon Bond Creation Listener
 * Single stream with bounded exponential-backoff-with-jitter reconnect.
 * @module horizonBondEvents
 */

import { Horizon } from '@stellar/stellar-sdk'
import type { Pool } from 'pg'
import { pool as defaultPool } from '../db/pool.js'
import { CursorRepository } from '../db/repositories/cursorRepository.js'
import { HorizonEventLedger } from '../db/repositories/horizonEventRepository.js'
import { register, Gauge } from 'prom-client'
import { BoundedBackoff } from '../utils/backoff.js'
import { getHorizonMetrics } from '../observability/horizonMetrics.js'
import { bondOperationSchema, DlqRouter, DlqReasonCode, validateAndRoute } from './messageValidator.js'
import {
  applyBondCreationEvent,
  type BondCreationIngestionEvent,
} from './horizonBondIngestion.js'

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
 *
 * Replay/idempotency (issue #1261): each event is processed through
 * `applyBondCreationEvent`, which binds the operation to its durable
 * `(stream_name, operation_id)` ledger key and deterministically returns
 * one of `applied` / `replayed` — or rejects stale and conflicting-key
 * deliveries without any state write. `onEvent` fires only for newly
 * `applied` events, so a duplicate delivery can never surface a second
 * business effect.
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
              const ingestionEvent: BondCreationIngestionEvent = {
                operationId: validation.data.id,
                pagingToken: newCursor,
                ...event,
              };
              // The event mutation, the versioned ledger record, and the
              // checkpoint are ONE durable unit handled by the ingestion
              // boundary (issue #1261): a process crash before COMMIT rolls
              // everything back so the next owner replays the event from the
              // previous cursor; a duplicate/conflicting/stale delivery is
              // resolved deterministically without a second business effect;
              // a ledger record only ever exists for a committed transition.
              const outcome = await applyBondCreationEvent({
                pool,
                event: ingestionEvent,
                ledger: eventLedger,
                streamName: STREAM_NAME,
              });
              cursor = newCursor;
              updateMetrics(cursorRepo);
              backoff.reset();
              if (outcome === 'applied' && onEvent) onEvent(event);
              console.log(`[${STREAM_NAME}] ${outcome === 'applied' ? 'Processed' : 'Replayed'} event ${op.id}, cursor: ${newCursor}`);
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
