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
import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import type { AddressInfo } from "net";
import {
  trustScoreNotifier,
  type TrustScoreUpdate,
} from "../services/reputation/notifier.js";
import {
  createWsSubscriptionServer,
  drainWsConnections,
  type WsSubscriptionConfig,
  type WsMessage,
} from "../routes/ws.js";
import { InMemoryApiKeyRepository } from "../repositories/apiKeyRepository.js";

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

// ---------------------------------------------------------------------------
// Shared helpers for ephemeral-server integration tests
// ---------------------------------------------------------------------------

interface TestServer {
  server: http.Server;
  wss: WebSocketServer;
  apiKey: string;
  baseUrl: string;
  /** Drain WS connections, stop HTTP server, clear notifier. */
  close(): Promise<void>;
}

/**
 * Spin up an in-process HTTP + WS subscription server bound to an ephemeral
 * port. Returns the server handle and a pre-registered API key for use in
 * upgrade requests.
 */
async function createTestServer(
  config: WsSubscriptionConfig = {},
): Promise<TestServer> {
  const repo = new InMemoryApiKeyRepository();
  const { key: apiKey } = repo.create("tenant-test", "read", "free");

  const wss = createWsSubscriptionServer({} as any, config, repo);
  const handleUpgrade = (wss as any)._handleUpgrade as (
    req: http.IncomingMessage,
    socket: any,
    head: Buffer,
  ) => Promise<void>;

  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    void handleUpgrade(req, socket, head);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    wss,
    apiKey,
    baseUrl: `ws://127.0.0.1:${port}`,
    async close() {
      trustScoreNotifier.clearAll();
      await drainWsConnections(wss, 200);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Open a WebSocket client, wait for the initial `subscribe_success` frame, and
 * return the connected socket. Rejects if the server refuses the upgrade or
 * sends an unexpected first message.
 */
function connectAndSubscribe(
  baseUrl: string,
  identity: string,
  apiKey: string,
  /** Optional extra ws client options (e.g. custom headers). */
  opts: ConstructorParameters<typeof WebSocket>[1] = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${baseUrl}/api/ws/subscribe/${identity}?key=${apiKey}`,
      opts,
    );
    ws.once("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMessage;
        if (msg.type === "subscribe_success") {
          resolve(ws);
        } else {
          reject(new Error(`Unexpected first message: ${msg.type}`));
        }
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", reject);
  });
}

/**
 * Collect up to `count` messages from `ws`, resolving early when the count is
 * reached or after `timeoutMs` elapses (returns however many arrived).
 */
function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 400,
): Promise<WsMessage[]> {
  return new Promise((resolve) => {
    const msgs: WsMessage[] = [];
    const timer = setTimeout(() => {
      ws.off("message", handler);
      resolve(msgs);
    }, timeoutMs);

    function handler(raw: WebSocket.RawData) {
      msgs.push(JSON.parse(raw.toString()) as WsMessage);
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msgs);
      }
    }
    ws.on("message", handler);
  });
}

// ---------------------------------------------------------------------------
// Auth & Upgrade rejection
// ---------------------------------------------------------------------------

describe("WebSocket Auth & Upgrade", () => {
  let ctx: TestServer;

  beforeEach(async () => {
    ctx = await createTestServer();
    trustScoreNotifier.clearAll();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("should reject upgrade when API key is absent", async () => {
    const result = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${ctx.baseUrl}/api/ws/subscribe/0xabc`);
      ws.once("error", () => resolve("error"));
      ws.once("close", () => resolve("close"));
    });
    expect(["close", "error"]).toContain(result);
    expect(ctx.wss.clients.size).toBe(0);
  });

  it("should reject upgrade when API key is invalid", async () => {
    const result = await new Promise<string>((resolve) => {
      const ws = new WebSocket(
        `${ctx.baseUrl}/api/ws/subscribe/0xabc?key=cr_not_a_real_key`,
      );
      ws.once("error", () => resolve("error"));
      ws.once("close", () => resolve("close"));
    });
    expect(["close", "error"]).toContain(result);
    expect(ctx.wss.clients.size).toBe(0);
  });

  it("should reject upgrade when identity segment is missing", async () => {
    // Path ends at /subscribe — no identity token
    const result = await new Promise<string>((resolve) => {
      const ws = new WebSocket(
        `${ctx.baseUrl}/api/ws/subscribe?key=${ctx.apiKey}`,
      );
      ws.once("error", () => resolve("error"));
      ws.once("close", () => resolve("close"));
    });
    expect(["close", "error"]).toContain(result);
    expect(ctx.wss.clients.size).toBe(0);
  });

  it("should accept a valid API key supplied via Authorization header", async () => {
    // Connect without the ?key= query param — only the Authorization header.
    const msg = await new Promise<WsMessage | "error" | "close">((resolve) => {
      const ws = new WebSocket(
        `${ctx.baseUrl}/api/ws/subscribe/0xhdr`,
        { headers: { Authorization: `Bearer ${ctx.apiKey}` } },
      );
      ws.once("message", (raw) =>
        resolve(JSON.parse(raw.toString()) as WsMessage),
      );
      ws.once("error", () => resolve("error"));
      ws.once("close", () => resolve("close"));
    });
    expect((msg as WsMessage).type).toBe("subscribe_success");
    // ctx.close() drains the server-side connection; no explicit ws.close() needed.
  });
});

// ---------------------------------------------------------------------------
// Identity normalization
// ---------------------------------------------------------------------------

describe("WebSocket Identity Normalization", () => {
  it("should lowercase the identity in subscribe_success", async () => {
    const ctx = await createTestServer();
    try {
      const msg = await new Promise<WsMessage>((resolve, reject) => {
        const ws = new WebSocket(
          `${ctx.baseUrl}/api/ws/subscribe/0XDEADBEEF?key=${ctx.apiKey}`,
        );
        ws.once("message", (raw) =>
          resolve(JSON.parse(raw.toString()) as WsMessage),
        );
        ws.once("error", reject);
      });
      expect(msg.type).toBe("subscribe_success");
      expect(msg.data?.identity).toBe("0xdeadbeef");
    } finally {
      await ctx.close();
    }
  });

  it("should route notifier updates using the normalised identity", async () => {
    const ctx = await createTestServer();
    try {
      // Subscribe via mixed-case URL
      const client = await connectAndSubscribe(
        ctx.baseUrl,
        "0XMixedCase",
        ctx.apiKey,
      );
      const pending = collectMessages(client, 1);

      // Publish to the all-lowercase version — must reach the subscriber
      trustScoreNotifier.publish("0xmixedcase", 77);

      const [msg] = await pending;
      expect(msg.type).toBe("score_update");
      expect(msg.data?.identity).toBe("0xmixedcase");
      client.close();
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

describe("WebSocket Backpressure", () => {
  it("should silently drop messages when bufferedAmount exceeds threshold", async () => {
    const ctx = await createTestServer({ backpressureThreshold: 100 });
    try {
      const client = await connectAndSubscribe(ctx.baseUrl, "0xbp", ctx.apiKey);

      // Get the server-side WebSocket for this connection.
      // wss.clients is a Set; after connectAndSubscribe resolves there is
      // exactly one entry (the subscribe_success ack was already sent).
      const [serverWs] = ctx.wss.clients;

      // Simulate a slow consumer by making bufferedAmount exceed the threshold.
      Object.defineProperty(serverWs, "bufferedAmount", {
        get: () => 200, // > backpressureThreshold(100)
        configurable: true,
      });

      // Start collecting; no messages should arrive within the window.
      const msgs = collectMessages(client, 1, 150);
      trustScoreNotifier.publish("0xbp", 42);

      const received = await msgs;
      expect(received).toHaveLength(0);

      // Restore normal bufferedAmount and verify delivery resumes.
      Object.defineProperty(serverWs, "bufferedAmount", {
        get: () => 0,
        configurable: true,
      });

      const resumed = collectMessages(client, 1);
      trustScoreNotifier.publish("0xbp", 99);
      const [next] = await resumed;
      expect(next.type).toBe("score_update");
      expect(next.data?.score).toBe(99);

      client.close();
    } finally {
      await ctx.close();
    }
  });

  it("should not affect connections whose buffer is within threshold", async () => {
    const ctx = await createTestServer({ backpressureThreshold: 100 });
    try {
      const slowClient = await connectAndSubscribe(
        ctx.baseUrl,
        "0xslow",
        ctx.apiKey,
      );
      const fastClient = await connectAndSubscribe(
        ctx.baseUrl,
        "0xfast",
        ctx.apiKey,
      );

      // Simulate backpressure only on the slow client's server-side socket.
      const clientsArr = [...ctx.wss.clients];
      // Identify server-side sockets: slow subscribed first so it's clientsArr[0].
      const serverSlow = clientsArr[0];
      Object.defineProperty(serverSlow, "bufferedAmount", {
        get: () => 200,
        configurable: true,
      });

      const slowMsgs = collectMessages(slowClient, 1, 150);
      const fastMsgs = collectMessages(fastClient, 1);

      trustScoreNotifier.publish("0xslow", 10);
      trustScoreNotifier.publish("0xfast", 20);

      expect(await slowMsgs).toHaveLength(0); // dropped
      const [fastMsg] = await fastMsgs;
      expect(fastMsg.type).toBe("score_update");

      slowClient.close();
      fastClient.close();
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Connection draining — graceful shutdown
// ---------------------------------------------------------------------------

describe("WebSocket Connection Draining", () => {
  it("should resolve immediately when no clients are connected", async () => {
    const ctx = await createTestServer();
    try {
      expect(ctx.wss.clients.size).toBe(0);
      const start = Date.now();
      await drainWsConnections(ctx.wss, 2000);
      expect(Date.now() - start).toBeLessThan(200);
    } finally {
      await ctx.close();
    }
  });

  it(
    "should close N connections within the grace window without hitting the hard timeout",
    { timeout: 8000 },
    async () => {
      const CONNECTIONS = 5;
      const GRACE_MS = 2000;

      const ctx = await createTestServer();
      try {
        const clients = await Promise.all(
          Array.from({ length: CONNECTIONS }, () =>
            connectAndSubscribe(ctx.baseUrl, "0xdrain", ctx.apiKey),
          ),
        );
        expect(ctx.wss.clients.size).toBe(CONNECTIONS);

        // Track client-side close events before initiating drain.
        const clientClosedPromises = clients.map(
          (ws) => new Promise<void>((res) => ws.once("close", res)),
        );

        const start = Date.now();
        await drainWsConnections(ctx.wss, GRACE_MS);
        const elapsed = Date.now() - start;

        // All server-side sockets must have been removed.
        expect(ctx.wss.clients.size).toBe(0);

        // Drain must complete well before the hard timeout fires.
        expect(elapsed).toBeLessThan(GRACE_MS - 200);

        // All clients must have received the close frame from the server.
        await Promise.all(clientClosedPromises);
      } finally {
        await ctx.close();
      }
    },
  );

  it("should complete drain even when one client disconnects abruptly before the close frame", async () => {
    const ctx = await createTestServer();
    try {
      const [stableClient, abruptClient] = await Promise.all([
        connectAndSubscribe(ctx.baseUrl, "0xstable", ctx.apiKey),
        connectAndSubscribe(ctx.baseUrl, "0xabrupt", ctx.apiKey),
      ]);
      expect(ctx.wss.clients.size).toBe(2);

      // Abruptly terminate one client; its server-side 'close' event fires
      // immediately, before drainWsConnections starts.
      abruptClient.terminate();
      // Give the TCP stack a tick to propagate the close to the server side.
      await new Promise<void>((r) => setTimeout(r, 20));

      // Drain should handle the mix of already-closed and still-open sockets.
      const stableClosedP = new Promise<void>((r) =>
        stableClient.once("close", r),
      );
      await drainWsConnections(ctx.wss, 1000);

      expect(ctx.wss.clients.size).toBe(0);
      await stableClosedP;
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-connection rate limiting
// ---------------------------------------------------------------------------

describe("WebSocket Per-Connection Rate Limiting", () => {
  it("should emit rate_limit messages when a single connection is flooded", async () => {
    const LIMIT = 3;
    const FLOOD = 10;

    const ctx = await createTestServer({ rateLimitPerSec: LIMIT });
    try {
      const client = await connectAndSubscribe(
        ctx.baseUrl,
        "0xflood",
        ctx.apiKey,
      );

      // Collect all messages that arrive from the flood.
      const pending = collectMessages(client, FLOOD);
      for (let i = 0; i < FLOOD; i++) {
        trustScoreNotifier.publish("0xflood", i);
      }
      const msgs = await pending;

      const types = msgs.map((m) => m.type);
      // First LIMIT messages come through as score_update.
      expect(types.slice(0, LIMIT).every((t) => t === "score_update")).toBe(
        true,
      );
      // Remaining messages are rate_limit notices.
      expect(
        types.slice(LIMIT).every((t) => t === "rate_limit"),
      ).toBe(true);

      client.close();
    } finally {
      await ctx.close();
    }
  });

  it("should throttle a noisy connection without affecting an independent connection", async () => {
    const LIMIT = 3;

    const ctx = await createTestServer({ rateLimitPerSec: LIMIT });
    try {
      const noisyClient = await connectAndSubscribe(
        ctx.baseUrl,
        "0xnoisy",
        ctx.apiKey,
      );
      const quietClient = await connectAndSubscribe(
        ctx.baseUrl,
        "0xquiet",
        ctx.apiKey,
      );

      // Collect from both concurrently.
      const noisyPending = collectMessages(noisyClient, LIMIT + 1);
      const quietPending = collectMessages(quietClient, 1);

      // Flood the noisy identity to trigger rate limiting.
      for (let i = 0; i < LIMIT + 2; i++) {
        trustScoreNotifier.publish("0xnoisy", i);
      }
      // Send exactly one update to the quiet identity.
      trustScoreNotifier.publish("0xquiet", 99);

      const noisyMsgs = await noisyPending;
      const quietMsgs = await quietPending;

      // Noisy connection must include at least one rate_limit frame.
      expect(noisyMsgs.some((m) => m.type === "rate_limit")).toBe(true);

      // Quiet connection must receive its score_update with no rate_limit.
      expect(quietMsgs).toHaveLength(1);
      expect(quietMsgs[0].type).toBe("score_update");
      expect(quietMsgs[0].data?.score).toBe(99);

      noisyClient.close();
      quietClient.close();
    } finally {
      await ctx.close();
    }
  });

  it("should reset the rate counter after one second", async () => {
    const LIMIT = 2;

    const ctx = await createTestServer({ rateLimitPerSec: LIMIT });
    try {
      const client = await connectAndSubscribe(
        ctx.baseUrl,
        "0xreset",
        ctx.apiKey,
      );

      // Fill the quota for the current second.
      const firstBatch = collectMessages(client, LIMIT);
      for (let i = 0; i < LIMIT; i++) {
        trustScoreNotifier.publish("0xreset", i);
      }
      const first = await firstBatch;
      expect(first.every((m) => m.type === "score_update")).toBe(true);

      // Wait for the 1-second window to roll over.
      await new Promise<void>((r) => setTimeout(r, 1050));

      // A fresh burst should be delivered without rate_limit.
      const secondBatch = collectMessages(client, LIMIT);
      for (let i = 0; i < LIMIT; i++) {
        trustScoreNotifier.publish("0xreset", 100 + i);
      }
      const second = await secondBatch;
      expect(second.every((m) => m.type === "score_update")).toBe(true);

      client.close();
    } finally {
      await ctx.close();
    }
  });
});
