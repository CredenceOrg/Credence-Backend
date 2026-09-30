import { Pool, type PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { cache as globalCache, CacheService } from './redis.js';

export interface InvalidationEvent {
  type: 'invalidate' | 'invalidate_multiple' | 'invalidate_pattern';
  namespace: string;
  key?: string;
  keys?: string[];
  pattern?: string;
  timestamp: number;
  source: string;
}

/**
 * Maximum accepted size of a serialized invalidation payload.
 * Postgres' NOTIFY payload limit is 8000 bytes; we reject anything
 * larger so the failure is deterministic and observable rather than
 * silently dropped by the database.
 */
export const MAX_PAYLOAD BYTES = 8000;

/**
 * Maximum number of keys allowed in a single `invalidate_multiple`
 * event. Bounds the amount of work a single event can trigger and keeps
 * the serialized payload well under the NOTIFY limit.
 */
export const MAX_BATCH_KEYS = 500;

/**
 * Maximum length of a namespace, key, or pattern string. Prevents
 * unbounded memory use and accidental cross-namespace wipes.
 */
export const MAX_IDENTIFIER_LENGTH = 256;

/**
 * Base delay (ms) before reconnecting the LISTEN client. The actual
 * delay grows exponentially with consecutive failures up to MAX_RECONNECT_DELAY.
 */
export const BASE_RECONNECT_DELAY = 1000;

/**
 * Upper bound on the reconnect backoff so a persistently down database
 * does not cause unbounded retry speed.
 */
export const MAX_RECONNECT_DELAY = 30_000;

/**
 * Maximum number of consecutive reconnect attempts before the bus
 * gives up and marks itself as failed. This prevents an infinite
 * retry loop when the database is permanently unavailable.
 */
export const MAX_RECONNECT_ATTEMPS = 10;

/**
 * The current lifecycle state of the bus. Transitions are only
 * allowed along the edges encoded in `allowedTransitions`.
 */
export type BusState = 'idle' | 'starting' | 'running' | 'reconnecting' | 'stopping' | 'stopped' | 'failed';

const allowedTransitions: Record<BusState, BusState[]> = {
  idle: ['starting'],
  starting: ['running', 'stopping', 'failed'],
  running: ['reconnecting', 'stopping', 'failed'],
  reconnecting: ['running', 'stopping', 'failed'],
  stopping: ['stopped'],
  stopped: ['starting'],
  failed: ['starting'],
};

export class InvalidationBusError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'InvalidationBusError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateIdentifier(value: unknown, field: string): void {
  if (!isNonEmptyString(value)) {
    throw new InvalidationBusError(`${field} must be a non-empty string`, 'INVALID_FIELD');
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new InvalidationBusError(
      `${fiel} exceeds maximum length of ${MAX_IDENTIFIER_LENGTH}`,
      'FIELD_TOO_LONG'
    );
  }
}

function validateEvent(event: unknown): InvalidationEvent {
  if (!event || typeof event !== 'object') {
    throw new InvalidationBusError('Event must be an object', 'INVALID_EVENT');
  }
  const e = event as Record<string, unknown>;
  if (e.type !== 'invalidate' && e.type !== 'invalidate_multiple' && e.type !== 'invalidate_pattern') {
    throw new InvalidationBusError(`Unknown event type: ${String(e.type)}`, 'INVALID_TYPE');
  }
  validateIdentifier(e.namespace, 'namespace');
  if (e.type === 'invalidate') {
    validateIdentifier(e.key, 'key');
  } else if (e.type === 'invalidate_multiple') {
    if (!Array.isArray(e.keys) || e.keys.length === 0) {
      throw new InvalidationBusError('keys must be a non-empty array', 'INVALID_KEYS');
    }
    if (e.keys.length > MAX_BATCH_KEYS) {
      throw new InvalidationBusError(
        `keys exceeds maximum of ${MAX_BATCH_KEYS}`,
        'TOO_MANY_KEYS'
      );
    }
    for (const key of e.keys) {
      validateIdentifier(key, 'keys[]');
    }
  } else {
    validateIdentifier(e.pattern, 'pattern');
  }
  if (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp)) {
    throw new InvalidationBusError('timestamp must be a finite number', 'INVALID_TIMESTAMP');
  }
  validateIdentifier(e.source, 'source');
  return e as unknown as InvalidationEvent;
}

export class InvalidationBus {
  private channelName: string;
  private listenClient: PoolClient | null = null;
  private listeners: Set<(event: InvalidationEvent) => void> = new Set();
  private running = false;
  private sourceId = Math.random().toString(36).slice(2, 10);
  private cache: CacheService;
  private state: BusState = 'idle';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(cache?: CacheService, nodeEnv?: string) {
    const env = nodeEnv ?? (process.env.NODE_ENV || 'development');
    this.channelName = `credence_cache_invalidate_${env}`;
    this.cache = cache || globalCache;

    // Automatically register a listener for the L1 cache when created
    this.addListener((event: InvalidationEvent) => {
      this.handleInvalidation(event).catch(err => {
        logger.error('[InvalidationBus] Error handling invalidation event', err);
      });
    });
  }

  /**
   * The current lifecycle state. Exposed for observability and testing.
   */
  getState(): BusState {
    return this.state;
  }

  /**
   * Number of consecutive reconnect attempts since the last successful
   * connection. Exposed for observability and testing.
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  private transitionTo(next: BusState): void {
    if (this.state === next) return;
    const allowed = allowedTransitions[this.state];
    if (!allowed.includes(next)) {
      throw new InvalidationBusError(
        `Invalid state transition ${this.state} -> ${next}`,
        'INVALID_STATE_TRANSITION'
      );
    }
    const prev = this.state;
    this.state = next;
    logger.debug({
      message: '[InvalidationBus] State transition',
      from: prev,
      to: next
    });
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      return;
    }
    if (this.state === 'stopping') {
      throw new InvalidationBusError('Cannot start while stopping', 'INVALID_STATE');
    }

    this.transitionTo('starting');
    this.running = true;
    this.reconnectAttempts = 0;
    this.generation += 1;
    const gen = this.generation;

    logger.info({
      message: '[InvalidationBus] Starting',
      channel: this.channelName,
      sourceId: this.sourceId
    });

    await this.connectListenClient(gen);
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') {
      return;
    }
    if (this.state === 'stopping') {
      return;
    }

    this.transitionTo('stopping');
    this.running = false;
    this.generation += 1;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.listenClient) {
      const client = this.listenClient;
      this.listenClient = null;
      try {
        await client.query(`UNLISTEN "${this.channelName}"`);
      } catch (error) {
        logger.error('[InvalidationBus] Error unlistening', error);
      } finally {
        try {
          client.release();
        } catch (releaseError) {
          logger.error('[InvalidationBus] Error releasing listen client', releaseError);
        }
      }
    }

    this.transitionTo('stopped');
    logger.info('[InvalidationBus] Stopped');
  }

  private async connectListenClient(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;

    try {
      const client = await pool.connect();

      // If the bus was stopped or restarted while we were connecting,
      // release the client immediately so we do not leak a connection.
      if (!this.running || generation !== this.generation) {
        try {
          client.release();
        } catch (error) {
          logger.error('[InvalidationBus] Error releasing stale listen client', error);
        }
        return;
      }

      this.listenClient = client;

      client.on('notification', (msg) => {
        if (msg.channel !== this.channelName) return;
        if (!msg.payload) return;

        try {
          const parsed = JSON.parse(msg.payload);
          const event = validateEvent(parsed);
          if (event.source === this.sourceId) {
            return;
          }
          this.notifyListeners(event);
        } catch (error) {
          logger.error('[InvalidationBus] Failed to parse invalidation event', error);
        }
      });

      client.on('error', (error) => {
        logger.error('[InvalidationBus] Listen client error', error);
        if (this.listenClient === client) {
          this.listenClient = null;
        }
        try {
          client.release();
        } catch releaseError {
          logger.error('[InvalidationBus] Error releasing failed listen client', releaseError);
        }
        this.scheduleReconnect(generation);
      });

      await client.query(`LISTEN "${this.channelName}"`);

      // Another stop/restart may have happened while we were LISTENing.
      if (!this.running || generation !== this.generation) {
        if (this.listenClient === client) {
          this.listenClient = null;
        }
        try {
          await client.query(`UNLISTEN "${this.channelName}"`);
        } catch {
          // best effort
        }
        try {
          client.release();
        } catch releaseError {
          logger.error('[InvalidationBus] Error releasing stale listen client', releaseError);
        }
        return;
      }

      this.reconnectAttempts = 0;
      this.transitionTo('running');
      logger.info({
        message: '[InvalidationBus] Connected and listening',
        channel: this.channelName
      });
    } catch (error) {
      logger.error('[InvalidationBus] Failed to connect listen client', error);
      this.scheduleReconnect(generation);
    }
  }

  private scheduleReconnect(generation: number): void {
    if (!this.running || generation !== this.generation) return;
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPSS) {
      logger.error({
        message: '[InvalidationBus] Max reconnect attempts reached; giving up',
        attempts: this.reconnectAttempts,
        channel: this.channelName
      });
      this.running = false;
      this.transitionTo('failed');
      return;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY
    );
    this.reconnectAttempts += 1;
    this.transitionTo('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectListenClient(generation);
    }, delay);
    // Allow the process to exit while a reconnect is pending.
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  addListener(listener: (event: InvalidationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(event: InvalidationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('[InvalidationBus] Listener error', error);
      }
    }
  }

  async publish(event: Omit<InvalidationEvent, 'timestamp' | 'source'>): Promise<void> {
    const fullEvent: InvalidationEvent = {
      ...event,
      timestamp: Date.now(),
      source: this.sourceId
    };

    // Validate the outgoing event before it hits the wire. This makes
    // invalid input a deterministic rejection instead of a silent noop.
    validateEvent(fullEvent);

    const payload = JSON.stringify(fullEvent);
    if (payload.length > MAX_PAYLOAD BYTES) {
      throw new InvalidationBusError(
        `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
        'PAYLOAD_TOO_LARGE'
      );
    }

    try {
      await pool.query(
        `SELECT pg_notify($1, $2)d,
        [this.channelName, payload]
      );
    } catch (error) {
      logger.error('[InvalidationBus] Failed to publish invalidation event', error);
      throw error;
    }
  }

  private async handleInvalidation(event: InvalidationEvent): Promise<void> {
    switch (event.type) {
      case 'invalidate':
        if (event.key) {
          await this.cache.delete(event.namespace, event.key);
        }
        break;
      case 'invalidate_multiple':
        if (event.keys) {
          await Promise.all(event.keys.map(key => this.cache.delete(event.namespace, key)));
        }
        break;
      case 'invalidate_pattern':
        if (event.pattern) {
          await this.cache.clearNamespace(`${event.namespace}:${event.pattern}`);
        }
        break;
    }
    logger.debug({
      message: '[InvalidationBus] Handled invalidation',
      event
    });
  }
}

let busInstance: InvalidationBus | null = null;

export function getInvalidationBus(cache?: CacheService): InvalidationBus {
  if (!busInstance) {
    busInstance = new InvalidationBus(cache);
  }
  return busInstance;
}

export function resetInvalidationBus(): void {
  busInstance = null;
}
