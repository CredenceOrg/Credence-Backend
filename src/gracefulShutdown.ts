import type http from "http";
import type { Socket } from "net";
import type { WebSocketServer } from "ws";
import { setReady } from "./lifecycle.js";
import { stop as stopListeners } from "./listeners/index.js";

export interface GracefulShutdownOptions {
  server?: http.Server | null;
  outboxJob?: { stop(): Promise<void> };
  scheduler?: { stop(): void | Promise<void> };
  invalidationBus?: { stop(): Promise<void> };
  gracePeriodMs?: number;
  forceExit?: (code: number) => void;
  logger?: (message: string) => void;
}

export class GracefulShutdownManager {
  private shuttingDown = false;
  private forceExitTimer: NodeJS.Timeout | null = null;
  private readonly connections = new Set<Socket>();
  private wss: WebSocketServer | null = null;

  constructor(private readonly options: GracefulShutdownOptions = {}) {}

  trackConnection(socket: Socket): void {
    this.connections.add(socket);
    socket.once("close", () => this.connections.delete(socket));
  }

  setServer(server: http.Server | null): void {
    this.options.server = server;
  }

  setOutboxJob(outboxJob: { stop(): Promise<void> } | null | undefined): void {
    this.options.outboxJob = outboxJob ?? undefined;
  }

  setScheduler(scheduler: { stop(): void | Promise<void> } | null | undefined): void {
    this.options.scheduler = scheduler ?? undefined;
  }

  setWss(wss: WebSocketServer | null): void {
    this.wss = wss;
  }

  setInvalidationBus(invalidationBus: { stop(): Promise<void> } | null | undefined): void {
    this.options.invalidationBus = invalidationBus ?? undefined;
  }

  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) {
      this.options.logger?.(
        `Graceful shutdown already in progress; received second signal ${signal}.`,
      );
      this.options.forceExit?.(1);
      return;
    }

    this.shuttingDown = true;
    setReady(false);
    this.options.logger?.(
      `[Shutdown] Received ${signal}; stopping HTTP server, listeners, and background workers.`,
    );

    const gracePeriodMs = this.options.gracePeriodMs ?? 30000;
    this.forceExitTimer = setTimeout(() => {
      this.options.logger?.(
        "[Shutdown] Shutdown grace period expired; forcing exit.",
      );
      this.destroyConnections();
      this.options.forceExit?.(1);
    }, gracePeriodMs);

    try {
      await this.closeServer();
      await this.drainWebSockets();
      await stopListeners();
      await this.options.outboxJob?.stop();
      await Promise.resolve(this.options.scheduler?.stop());
      await this.options.invalidationBus?.stop();
      this.options.logger?.("[Shutdown] Graceful shutdown complete.");
      this.clearForceExitTimer();
      this.options.forceExit?.(0);
    } catch (error) {
      this.options.logger?.(
        `[Shutdown] Error during shutdown: ${error instanceof Error ? error.message : error}`,
      );
      this.destroyConnections();
      this.clearForceExitTimer();
      this.options.forceExit?.(1);
    }
  }

  private drainWebSockets(): Promise<void> {
    if (!this.wss) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const drainTimeoutMs = 5000;
      const timeoutHandle = setTimeout(() => {
        // Force close remaining connections
        for (const ws of this.wss!.clients) {
          ws.terminate();
        }
        resolve();
      }, drainTimeoutMs);

      // Notify all connected clients of graceful shutdown
      for (const ws of this.wss!.clients) {
        if (ws.readyState === 1) {
          // WebSocket.OPEN
          ws.close(1000, "Server shutting down gracefully");
        }
      }

      // Wait for clients to close
      let closed = 0;
      const checkAllClosed = () => {
        if (closed >= this.wss!.clients.size) {
          clearTimeout(timeoutHandle);
          resolve();
        }
      };

      for (const ws of this.wss!.clients) {
        ws.once("close", () => {
          closed++;
          checkAllClosed();
        });
      }

      // If no clients, resolve immediately
      if (this.wss!.clients.size === 0) {
        clearTimeout(timeoutHandle);
        resolve();
      }
    });
  }

  private closeServer(): Promise<void> {
    const server = this.options.server;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private destroyConnections(): void {
    for (const socket of this.connections) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
  }

  private clearForceExitTimer(): void {
    if (this.forceExitTimer) {
      clearTimeout(this.forceExitTimer);
      this.forceExitTimer = null;
    }
  }
}
