import client from 'prom-client';

/**
 * Synthetic probe success counter – increments for each successful end‑to‑end run.
 */
export const syntheticProbeSuccessTotal = new client.Counter({
  name: 'synthetic_probe_success_total',
  help: 'Total successful synthetic probe executions',
  registers: [client.register],
});

/**
 * Synthetic probe failure counter – labelled by step where failure occurred.
 */
export const syntheticProbeFailureTotal = new client.Counter({
  name: 'synthetic_probe_failure_total',
  help: 'Total synthetic probe failures labelled by step',
  labelNames: ['step'],
  registers: [client.register],
});

/**
 * Webhook payload size histogram – records webhook payload bytes per subscriber.
 */
export const webhookPayloadBytes = new client.Histogram({
  name: 'webhook_payload_bytes',
  help: 'Histogram of webhook payload sizes in bytes per subscriber',
  labelNames: ['subscriber'],
  buckets: [1024, 4096, 16384, 65536, 262144, 1048576, 4194304],
  registers: [client.register],
});

export const dbTxnDurationSeconds = new client.Histogram({
  name: 'db_txn_duration_seconds',
  help: 'Database transaction duration in seconds',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [client.register],
});

export const dbTxnSavepoints = new client.Histogram({
  name: 'db_txn_savepoints',
  help: 'Database transaction savepoints count',
  buckets: [0, 1, 2, 4, 8, 16],
  registers: [client.register],
});

/**
 * Counter for queries whose duration exceeded SLOW_QUERY_THRESHOLD_MS.
 */
export const dbSlowQueriesTotal = new client.Counter({
  name: 'db_slow_queries_total',
  help: 'Total number of database queries exceeding SLOW_QUERY_THRESHOLD_MS',
  labelNames: ['pool'],
  registers: [client.register],
});

/**
 * Duration histogram for queries whose duration exceeded SLOW_QUERY_THRESHOLD_MS.
 */
export const dbSlowQueryDurationSeconds = new client.Histogram({
  name: 'db_slow_query_duration_seconds',
  help: 'Duration of database queries that exceeded SLOW_QUERY_THRESHOLD_MS, in seconds',
  labelNames: ['pool'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [client.register],
});

/**
 * Counter for WebSocket slow consumers that were evicted.
 */
export const wsEvictedSlowConsumersTotal = new client.Counter({
  name: 'ws_evicted_slow_consumers_total',
  help: 'Total number of WebSocket connections evicted due to slow consumption (exceeding backpressure high-water mark)',
  registers: [client.register],
});

/**
 * Register the custom metrics with an external registry if needed.
 * The caller can pass its own Registry; otherwise the default global one is used.
 */
export function registerSyntheticMetrics(registry?: client.Registry): void {
  const reg = registry ?? client.register;
  reg.registerMetric(syntheticProbeSuccessTotal);
  reg.registerMetric(syntheticProbeFailureTotal);
  reg.registerMetric(webhookPayloadBytes);
  reg.registerMetric(dbTxnDurationSeconds);
  reg.registerMetric(dbTxnSavepoints);
  reg.registerMetric(wsEvictedSlowConsumersTotal);
  reg.registerMetric(dbSlowQueriesTotal);
  reg.registerMetric(dbSlowQueryDurationSeconds);
}
