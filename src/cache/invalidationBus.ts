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
 * PostgreSQL NOTIFY payloads are capped at 8000 bytes by default; we
 * prevent events that would be silently dropped by the database from
 * being published at all.
 */
export const MAX_PAYLOAD_BYTES = 8000;

/**
 * Maximum number of keys accepted in a single `InvalidationEvent`.
 * This bounds the work done by a single event and prevents a malicious
 * or buggy publisher from causing an unbounded fan-out of Redis deletes.
 */
export const MAX_KEYS = 1000;

/**
 * Maximum length of a namespace or key string. Prevents bloated
 * payloads and accidental glob injection through overly long identifiers.
 */
export const MAX_IDENTIFIER_LENGTH = 512;

export class InvalidationBusError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'InvalidationBusError';
  }
}

export class InvalidationBus {
  private channelName: string;
  private listenClient: PoolClient | null = null;
  private listeners: Set<(event: InvalidationEvent) => void> = new Set();
  private running = false;
  private sourceId = Math.random().toString(36).slice(2, 10);
  private cache: CacheService;
  /** Timer handle for the pending reconnect, if any. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Number of consecutive reconnect attempts (for backoff). */
  private reconnectAttempts = 0;
  /** Gate that ensures only one connect attempt is in flight at a time. */
  private connecting: Promise<void> | null = null;
  /** Events that arrived while the bus was not running. */
  private pendingEvents: InvalidationEvent[] = [];
  /** Maximum number of events buffered while stopped. */
  private readonly maxPendingEvents = 1000;

  constructor(cache?: CacheService, nodeEnv?: string) {
    const env = nodeEnv ??  process.env.NODE_ENV || 'development';
    this.channelName = `credence_cache_invalidate_${env}`;
    this.cache = cache || globalCache;

    // Automatically register a listener for the L1 cache when created
    this.addListener((event: InvalidationEvent) => {
      this.handleInvalidation(event).catch(err => {
        logger.error('[InvalidationBus] Error handling invalidation event', err);
      });
    });
  }

  /** Whether the bus is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Exposed for testing: number of buffered events while stopped. */
  getPendingEventCount(): number {
    return this.pendingEvents.length;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.reconnectAttempts = 0;
    logger.info({
      message: '[InvalidationBus] Starting',
      channel: this.channelName,
      sourceId: this.sourceId
    });

    await this.connectListenClient();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    // Cancel any pending reconnect timer so it cannot revive the client
    // after we have deliberately stopped.
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
        logger.error('[InvalidationBus] Error unlistening listen client', error);
      } finally {
        try {
          client.release();
        } catch (error) {
          logger.error('[InvalidationBus] Error releasing listen client', error);
        }
      }
    }
    logger.info('[InvalidationBus] Stopped');
  }

  /**
   * Schedule a reconnect with exponential backoff. Only one timer may
   * be pending at a time, and no timer is scheduled once the bus is
   * stopped. This guarantees that `connectListenClient` cannot be called
   * concurrently from multiple failure paths.
   */
  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;

    const attempt = this.reconnectAttempts++;
    // 100ms, 200ms, 400ms, ... capped at 30s.
    const delay = Math.min(100 * 2 ** attempt, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      void this.connectListenClient();
    }, delay);
    // Never keep the process alive just for a reconnect timer.
    if (typeof this.reconnectTimer === 'object' && this.reconnectTimer !== null) {
      (this.reconnectTimer as unknown as { unref??: () => void }).unref?.();
    }
  }

  private async connectListenClient(): Promise<void> {
    if (!this.running) return;
    // Coalesce concurrent connect attempts into a single in-flight promise.
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    try {
      const client = await pool.connect();

      // If the bus was stopped while we were awaiting the connection,
      // release the client immediately instead of leaking it.
      if (!this.running) {
        client.release();
        return;
      }

      this.listenClient = client;

      client.on('notification', (msg) => {
        if (msg.channel !== this.channelName) return;
        if (!msg.payload) return;

        try {
          const event = JSON.parse(msg.payload) as InvalidationEvent;
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
        // Drop the broken client so subsequent reconnects do not reuse it.
        if (this.listenClient === client) {
          this.listenClient = null;
        }
        try {
          client.release();
        } catch (releaseError) {
          logger.error('[InvalidationBus] Error releasing failed listen client', releaseError);
        }
        this.scheduleReconnect();
      });

      await client.query(`LISTEN "${this.channelName}"`);
      this.reconnectAttempts = 0;
      logger.info({
        message: '[InvalidationBus] Connected and listening',
        channel: this.channelName
      });
    } catch (error) {
      logger.error('[InvalidationBus] Failed to connect listen client', error);
      this.scheduleReconnect();
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

  /**
   * Validate an outgoing event before it is serialized and published.
   * Throws an `InvalidationBusError` when the event is malformed or
   * would exceed the PostgreSQL NOTIFY size limit.
   */
  private validateEvent(event: Omit<InvalidationEvent, 'timestamp' | 'source'>): void {
    if (!event || typeof event !== 'object') {
      throw new InvalidationBusError('Invalidation event must be an object', 'INVALID_EVENT');
    }
    if (event.type !== 'invalidate' && event.type !== 'invalidate_multiple' && event.type !== 'invalidate_pattern') {
      throw new InvalidationBusError(`Unsupported invalidation type: ${String((event as { type?: unknown }).type)}`, 'INVALID_TYPE');
    }
    if (typeof event.namespace !== 'string' || event.namespace.length === 0) {
      throw new InvalidationBusError('namespace is required and must be a non-empty string', 'INVALID_NAMESPACE');
    }
    if (event.namespace.length > MAX_IDENTIFIER_LENGTH) {
      throw new InvalidationBusError(`namespace exceeds ${MAX_IDENTIFIER_LENGTH} characters`, 'NAMESPACE_TOO_LONG');
    }

    switch (event.type) {
      case 'invalidate':
        if (typeof event.key !== 'string' || event.key.length === 0) {
          throw new InvalidationBusError('key is required for invalidate events', 'MISSING_KEY');
        }
        if (event.key.length > MAX_IDENTIFIER_LENGTH) {
          throw new InvalidationBusError(`key exceeds ${MAX_IDENTIFIER_LENGTH} characters`, 'KEY_TOO_LONG');
        }
        break;
      case 'invalidate_multiple':
        if (!Array.isArray(event.keys) || event.keys.length === 0) {
          throw new InvalidationBusError('keys is required for invalidate_multiple events', 'MISSING_KEYS');
        }
        if (event.keys.length > MAX_KEYS) {
          throw new InvalidationBusError(`keys exceeds the maximum of ${MAX_KEYS}`, 'TOO_MANY_KEYS');
        }
        for (const key of event.keys) {
          if (typeof key !== 'string' || key.length === 0) {
            throw new InvalidationBusError(`keys must be non-empty strings`, 'INVALID_KEY');
          }
          if (key.length > MAX_IDENTIFIER_LENGTH) {
            throw new InvalidationBusError(`key exceeds ${MAX_IDENTIFIER_LENGTH} characters`, 'KEY_TOO_LONG');
          }
        }
        break;
      case 'invalidate_pattern':
        if (typeof event.pattern !== 'string' || event.pattern.length === 0) {
          throw new InvalidationBusError('pattern is required for invalidate_pattern events', 'MISSING_PATTERN');
        }
        if (event.pattern.length > MAX_IDENTIFIER_LENGTH) {
          throw new InvalidationBusError(`pattern exceeds ${MAX_IDENTIFIER_LENGTH} characters`, 'PATTERN_TOO_LONG');
        }
        break;
    }
  }

  /**
   * Publish an invalidation event to the PostgreSQL notification channel.
   *
   * Throws an `InvalidationBusError` if the event is invalid or too
   * large to be delivered. This is deliberate: silently dropping an
   * invalidation event would leave peer nodes serving stale data.
   */
  async publish(event: Omit<InvalidationEvent, 'timestamp' | 'source'>): Promise<void> {
    this.validateEvent(event);

    const fullEvent: InvalidationEvent = {
      ...event,
      timestamp: Date.now(),
      source: this.sourceId
    };

    const payload = JSON.stringify(fullEvent);
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new InvalidationBusError(
        `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes; split the invalidation into smaller batches`,
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

  /**
   * Handle an incoming invalidation event locally. This is also used by
   * the bus to apply events that were buffered while the bus was stopped.
   * Exposed as a public method so tests and callers can replay events
   * deterministically.
   */
  async handleInvalidation(event: InvalidationEvent): Promise<void> {
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

  /**
   * Buffer an event that arrived while the bus was not running.
   * The buffer is bounded to avoid unbounded memory growth in a stopped
   * bus. Once full, oldest events are dropped and a warning is emitted.
   */
  bufferEvent(event: InvalidationEvent): void {
    if (this.pendingEvents.length >= this.maxPendingEvents) {
      const dropped = this.pendingEvents.shift();
      logger.warn({
        message: '[InvalidationBus] Pending event buffer full; dropping oldest event',
        dropped
      });
    }
    this.pendingEvents.push(event);
  }

  /**
   * Drain and apply any events buffered while the bus was stopped.
   * Returns the number of events applied. Errors from individual events
   * are logged but do not abort the drain, so a single bad event cannot
   * block recovery of the rest.
   */
  async drainPendingEvents(): Promise<number> {
    const pending = this.pendingEvents;
    this.pendingEvents = [];
    let applied = 0;
    for (const event of pending) {
      try {
        await this.handleInvalidation(event);
        applied++;
      } catch (error) {
        logger.error('[InvalidationBus] Failed to apply buffered event', error);
      }
    }
    return applied;
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
