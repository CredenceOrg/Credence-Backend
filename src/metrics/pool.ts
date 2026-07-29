import type { Pool } from "pg";

export interface PoolTelemetry {
  activeConnections: number;
  idleConnections: number;
  pendingRequests: number;
  maxPoolSize: number;
  saturationRatio: number;
}

export function collectPoolTelemetry(pool: Pool, maxSize: number): PoolTelemetry {
  const activeConnections = pool.totalCount - pool.idleCount;
  return {
    activeConnections,
    idleConnections: pool.idleCount,
    pendingRequests: pool.waitingCount,
    maxPoolSize: maxSize,
    saturationRatio: maxSize > 0 ? activeConnections / maxSize : 0,
  };
}