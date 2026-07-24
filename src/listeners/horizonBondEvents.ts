/**
 * Horizon Bond Creation Listener
 * Single stream with bounded exponential-backoff-with-jitter reconnect.
 * @module horizonBondEvents
 */

import { Horizon } from '@stellar/stellar-sdk'
import type { Pool } from 'pg'
import { upsertIdentity, upsertBond } from '../services/identityService.js'
import { CursorRepository } from '../db/repositories/cursorRepository.js'
import { pool } from '../db/pool.js'
import { register, Gauge } from 'prom-client'
import { BoundedBackoff } from '../utils/backoff.js'
import { getHorizonMetrics } from '../observability/horizonMetrics.js'
import { bondOperationSchema, validateMessage } from './messageValidator.js'

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
 */
export function subscribeBondCreationEvents(
  replayService: {
    captureFailure: (type: string, data: any, reason: string) => Promise<unknown>;
  },
  onEvent?: (event: {
    identity: { id: string };
    bond: { id: string; address: string; amount: string; duration: string | null };
  }) => void,
  pool?: Pool
): BondCreationHandle {
  const cursorRepo = pool ? new CursorRepository(pool) : undefined;
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
              const validation = validateMessage(bondOperationSchema, op);
              if (!validation.valid) {
                if (replayService?.captureFailure) {
                  await replayService.captureFailure(STREAM_NAME, op, validation.detail || "Validation failed");
                } else {
                  console.error(`[${STREAM_NAME}] Validation failed for event ${op.id}: ${validation.detail}`);
                }
                return;
              }
              const event = parseBondEvent(op);
              await upsertIdentity(event.identity);
              await upsertBond(event.bond);
              if (cursorRepo) {
                await cursorRepo.upsert({ streamName: STREAM_NAME, pagingToken: newCursor });
              }
              cursor = newCursor;
              if (cursorRepo) updateMetrics(cursorRepo);
              if (onEvent) onEvent(event);
              backoff.reset();
              console.log(`[${STREAM_NAME}] Processed event ${op.id}, cursor: ${newCursor}`);
            }
          } catch (err) {
            console.error(`[${STREAM_NAME}] Error processing event ${op.id}:`, err);
            throw err;
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
    if (cursorRepo) {
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

async function updateMetrics(cursorRepo: CursorRepository) {
  try {
    const lag = await cursorRepo.getCursorLag(STREAM_NAME);
    if (lag !== null) cursorLagGauge.set({ stream_name: STREAM_NAME }, lag);
    const cursor = await cursorRepo.findByStreamName(STREAM_NAME);
    if (cursor) {
      lastCheckpointGauge.set(
        { stream_name: STREAM_NAME },
        Math.floor(cursor.lastCheckpoint.getTime() / 1000)
      );
    }
  } catch (err) {
    console.error(`[${STREAM_NAME}] Error updating metrics:`, err);
  }
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
