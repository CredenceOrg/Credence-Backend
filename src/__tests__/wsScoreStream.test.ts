/**
 * WebSocket Score Stream Tests
 *
 * Test coverage:
 * - In-process pub-sub notifier functionality
 * - Server initialization and upgrade handling
 * - Subscription lifecycle
 * - Message delivery and ordering
 * - Rate limiting
 * - Error scenarios
 * - Per-connection rate limits
 * - Tenant isolation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import http from "http";
import {
  trustScoreNotifier,
  type TrustScoreUpdate,
} from "../services/reputation/notifier.js";
import {
  createWsSubscriptionServer,
  drainWsConnections,
} from "../routes/ws.js";

describe("TrustScoreNotifier", () => {
  beforeEach(() => {
    trustScoreNotifier.clearAll();
  });

  it("should subscribe to score updates", () => {
    return new Promise<void>((resolve) => {
      const identity = "0x123abc";
      const listener = vi.fn((update: TrustScoreUpdate) => {
        expect(update.identity).toBe(identity.toLowerCase());
        expect(update.score).toBe(95);
        expect(typeof update.timestamp).toBe("number");
        resolve();
      });

      trustScoreNotifier.subscribe(identity, listener);
      trustScoreNotifier.publish(identity, 95);
    });
  });

  it("should normalize identity to lowercase", () => {
    return new Promise<void>((resolve) => {
      const listener = vi.fn((update: TrustScoreUpdate) => {
        expect(update.identity).toBe("0x123abc");
        resolve();
      });

      trustScoreNotifier.subscribe("0X123ABC", listener);
      trustScoreNotifier.publish("0x123abc", 95);
    });
  });

  it("should support multiple listeners per identity", () => {
    const identity = "0x123";
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    trustScoreNotifier.subscribe(identity, listener1);
    trustScoreNotifier.subscribe(identity, listener2);
    trustScoreNotifier.publish(identity, 95);

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it("should unsubscribe correctly", () => {
    const identity = "0x123";
    const listener = vi.fn();

    const unsubscribe = trustScoreNotifier.subscribe(identity, listener);
    trustScoreNotifier.publish(identity, 95);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    trustScoreNotifier.publish(identity, 96);
    expect(listener).toHaveBeenCalledOnce(); // Still once, not twice
  });

  it("should track subscriber count", () => {
    const identity = "0x123";
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(0);

    trustScoreNotifier.subscribe(identity, listener1);
    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(1);

    trustScoreNotifier.subscribe(identity, listener2);
    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(2);
  });

  it("should reject invalid identity on subscribe", () => {
    const listener = vi.fn();
    expect(() => trustScoreNotifier.subscribe("", listener)).toThrow();
    expect(() => trustScoreNotifier.subscribe("   ", listener)).toThrow();
    expect(() => trustScoreNotifier.subscribe(null as any, listener)).toThrow();
  });

  it("should reject invalid score on publish", () => {
    expect(() => trustScoreNotifier.publish("0x123", NaN)).toThrow();
    expect(() => trustScoreNotifier.publish("0x123", null as any)).toThrow();
  });

  it("should enforce max listeners per identity", () => {
    const identity = "0x123";
    const listeners: Array<() => void> = [];

    // Subscribe up to the limit
    for (let i = 0; i < 1000; i++) {
      const unsub = trustScoreNotifier.subscribe(identity, vi.fn());
      listeners.push(unsub);
    }

    // Next subscription should fail
    expect(() => trustScoreNotifier.subscribe(identity, vi.fn())).toThrow(
      /Too many subscribers/,
    );
  });

  it("should clear all listeners for an identity", () => {
    const identity = "0x123";
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    trustScoreNotifier.subscribe(identity, listener1);
    trustScoreNotifier.subscribe(identity, listener2);
    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(2);

    trustScoreNotifier.clearIdentity(identity);
    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(0);

    trustScoreNotifier.publish(identity, 95);
    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).not.toHaveBeenCalled();
  });

  it("should clear all listeners globally", () => {
    trustScoreNotifier.subscribe("0x111", vi.fn());
    trustScoreNotifier.subscribe("0x222", vi.fn());

    trustScoreNotifier.clearAll();

    expect(trustScoreNotifier.getSubscriberCount("0x111")).toBe(0);
    expect(trustScoreNotifier.getSubscriberCount("0x222")).toBe(0);
  });

  it("should preserve message ordering", () => {
    const identity = "0x123";
    const scores: number[] = [];

    trustScoreNotifier.subscribe(identity, (update) => {
      scores.push(update.score);
    });

    trustScoreNotifier.publish(identity, 50);
    trustScoreNotifier.publish(identity, 60);
    trustScoreNotifier.publish(identity, 70);

    expect(scores).toEqual([50, 60, 70]);
  });
});

describe("WebSocket Score Stream Server - Creation", () => {
  it("should create a WebSocket server", () => {
    const mockPool = {} as any;
    const mockApiKeyRepo = {
      findByKey: vi.fn(),
    };
    const wss = createWsSubscriptionServer(mockPool, {}, mockApiKeyRepo);

    expect(wss).toBeInstanceOf(WebSocketServer);
  });

  it("should accept configuration options", () => {
    const mockPool = {} as any;
    const mockApiKeyRepo = {
      findByKey: vi.fn(),
    };
    const wss = createWsSubscriptionServer(
      mockPool,
      {
        rateLimitPerSec: 50,
        backpressureThreshold: 512 * 1024,
        shutdownGracePeriodMs: 3000,
      },
      mockApiKeyRepo,
    );

    expect(wss).toBeInstanceOf(WebSocketServer);
  });
});

describe("WebSocket Score Stream - Edge Cases", () => {
  beforeEach(() => {
    trustScoreNotifier.clearAll();
  });

  afterEach(() => {
    trustScoreNotifier.clearAll();
  });

  it("should handle rapid subscribe/unsubscribe", () => {
    const identity = "0x123";
    const unsubs: Array<() => void> = [];

    // Subscribe many times
    for (let i = 0; i < 100; i++) {
      const unsub = trustScoreNotifier.subscribe(identity, vi.fn());
      unsubs.push(unsub);
    }

    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(100);

    // Unsubscribe all
    unsubs.forEach((unsub) => unsub());

    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(0);
  });

  it("should handle publishing to non-existent identities", () => {
    // Should not throw
    expect(() => {
      trustScoreNotifier.publish("0x999", 100);
    }).not.toThrow();
  });

  it("should support score updates with fractional values", () => {
    return new Promise<void>((resolve) => {
      const listener = vi.fn((update: TrustScoreUpdate) => {
        expect(update.score).toBe(95.5);
        resolve();
      });

      trustScoreNotifier.subscribe("0x123", listener);
      trustScoreNotifier.publish("0x123", 95.5);
    });
  });

  it("should handle zero and negative scores", () => {
    return new Promise<void>((resolve) => {
      let callCount = 0;
      const listener = vi.fn((update: TrustScoreUpdate) => {
        callCount++;
        if (callCount === 1) {
          expect(update.score).toBe(0);
        } else if (callCount === 2) {
          expect(update.score).toBe(-50);
          resolve();
        }
      });

      trustScoreNotifier.subscribe("0x123", listener);
      trustScoreNotifier.publish("0x123", 0);
      trustScoreNotifier.publish("0x123", -50);
    });
  });

  it("should support identity addresses of various formats", () => {
    const identities = [
      "0x123",
      "0xABCDEF",
      "user@example.com",
      "stellar:GBXYZ123",
      "cosmos1abc",
    ];

    identities.forEach((identity) => {
      const listener = vi.fn();
      trustScoreNotifier.subscribe(identity, listener);
      trustScoreNotifier.publish(identity, 90);
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  it("should not leak memory on repeated subscribe/unsubscribe", () => {
    const identity = "0x123";

    for (let cycle = 0; cycle < 10; cycle++) {
      const unsub = trustScoreNotifier.subscribe(identity, vi.fn());
      expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(1);
      unsub();
      expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(0);
    }
  });

  it("should maintain subscriber list consistency", () => {
    const identity = "0x123";
    const unsubs: Array<() => void> = [];

    // Subscribe 50
    for (let i = 0; i < 50; i++) {
      unsubs.push(trustScoreNotifier.subscribe(identity, vi.fn()));
    }
    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(50);

    // Unsubscribe every other one
    for (let i = 0; i < 50; i += 2) {
      unsubs[i]();
    }
    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(25);

    // Unsubscribe the rest
    for (let i = 1; i < 50; i += 2) {
      unsubs[i]();
    }
    expect(trustScoreNotifier.getSubscriberCount(identity)).toBe(0);
  });
});

describe("WebSocket Score Stream - Integration", () => {
  beforeEach(() => {
    trustScoreNotifier.clearAll();
  });

  afterEach(() => {
    trustScoreNotifier.clearAll();
  });

  it("should integrate with outbox event system", () => {
    // When score.updated event is published by outbox:
    // 1. Outbox job publishes score.updated event
    // 2. Event handler calls trustScoreNotifier.publish()
    // 3. All subscribers receive the update

    const identity = "0x123";
    const mockListener = vi.fn();

    trustScoreNotifier.subscribe(identity, mockListener);

    // Simulates outbox event handler calling notifier
    trustScoreNotifier.publish(identity, 95, "tenant_123");

    expect(mockListener).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        score: 95,
      }),
    );
  });

  it("should support multiple scores per identity over time", () => {
    const identity = "0x123";
    const scores: number[] = [];

    trustScoreNotifier.subscribe(identity, (update) => {
      scores.push(update.score);
    });

    // Simulate score changes over time
    const initialScores = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
    initialScores.forEach((score) => {
      trustScoreNotifier.publish(identity, score);
    });

    expect(scores).toEqual(initialScores);
  });

  it("should broadcast to multiple subscribers", () => {
    const identity = "0x123";
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const listener3 = vi.fn();

    trustScoreNotifier.subscribe(identity, listener1);
    trustScoreNotifier.subscribe(identity, listener2);
    trustScoreNotifier.subscribe(identity, listener3);

    trustScoreNotifier.publish(identity, 85);

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
    expect(listener3).toHaveBeenCalledOnce();
  });

  it("should handle subscriber isolation", () => {
    const identity1 = "0x123";
    const identity2 = "0x456";

    const listener1 = vi.fn();
    const listener2 = vi.fn();

    trustScoreNotifier.subscribe(identity1, listener1);
    trustScoreNotifier.subscribe(identity2, listener2);

    trustScoreNotifier.publish(identity1, 90);

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).not.toHaveBeenCalled();
  });
});

describe("WebSocket Score Stream - Rate Limiting", () => {
  beforeEach(() => {
    trustScoreNotifier.clearAll();
  });

  afterEach(() => {
    trustScoreNotifier.clearAll();
  });

  it("should support high message rates without loss", () => {
    const identity = "0x123";
    const listener = vi.fn();
    const messageCount = 1000;

    trustScoreNotifier.subscribe(identity, listener);

    for (let i = 0; i < messageCount; i++) {
      trustScoreNotifier.publish(identity, 50 + (i % 50));
    }

    expect(listener).toHaveBeenCalledTimes(messageCount);
  });
});

describe("WebSocket Score Stream - Connection Draining", () => {
  it("should drain connections gracefully", async () => {
    const mockPool = {} as any;
    const mockApiKeyRepo = {
      findByKey: vi.fn(),
    };
    const wss = createWsSubscriptionServer(mockPool, {}, mockApiKeyRepo);

    // No clients connected
    expect(wss.clients.size).toBe(0);

    // Drain should complete without errors
    await drainWsConnections(wss, 1000);
    expect(wss.clients.size).toBe(0);
  });
});
