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

export class InvalidationBus {
  private channelName: string;
  private listenClient: PoolClient | null = null;
  private listeners: Set<(event: InvalidationEvent) => void> = new Set();
  private running = false;
  private sourceId = Math.random().toString(36).slice(2, 10);
  private cache: CacheService;

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

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
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
    if (this.listenClient) {
      try {
        await this.listenClient.query(`UNLISTEN "${this.channelName}"`);
        this.listenClient.release();
        this.listenClient = null;
      } catch (error) {
        logger.error('[InvalidationBus] Error stopping listen client', error);
      }
    }
    logger.info('[InvalidationBus] Stopped');
  }

  private async connectListenClient(): Promise<void> {
    if (!this.running) return;

    try {
      const client = await pool.connect();
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
        if (this.running) {
          setTimeout(() => this.connectListenClient(), 1000);
        }
      });

      await client.query(`LISTEN "${this.channelName}"`);
      logger.info({
        message: '[InvalidationBus] Connected and listening',
        channel: this.channelName
      });
    } catch (error) {
      logger.error('[InvalidationBus] Failed to connect listen client', error);
      if (this.running) {
        setTimeout(() => this.connectListenClient(), 1000);
      }
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

    const payload = JSON.stringify(fullEvent);
    if (payload.length > 8000) {
      logger.warn('[InvalidationBus] Payload exceeds 8KB limit');
    }

    try {
      await pool.query(
        `SELECT pg_notify($1, $2)`,
        [this.channelName, payload]
      );
    } catch (error) {
      logger.error('[InvalidationBus] Failed to publish invalidation event', error);
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
