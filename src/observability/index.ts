/**
 * Observability module - metrics, tracing, and monitoring utilities.
 */

export {
  normalizeRoute,
  httpRequestDurationHistogram,
  httpRequestStatusTotal,
  registerLatencyMetrics,
} from './latencyMetrics.js'

export {
  TimeoutEvent,
  SlowOperationEvent,
  SuccessEvent,
  TimeoutMetricsSummary,
  TimeoutMetricsCollector,
  ConsoleTimeoutMetrics,
  ProductionTimeoutMetrics,
  createDefaultMetricsCollector,
  createTimeoutEvent,
  createSlowOperationEvent,
  createSuccessEvent,
} from './timeoutMetrics.js'

export { registerPoolMetrics, registerPreparedStatementCacheMetrics } from './poolMetrics.js'
export {
  DOWNSTREAM_RPC_LATENCY_BUCKETS_MS,
  downstreamRpcLatencyHistogram,
  recordDownstreamRpcLatency,
  registerRpcLatencyMetrics,
} from './rpcLatencyMetrics.js'
export {
  incrementOutboxDeadLetter,
  incrementOutboxPublished,
  incrementOutboxFailed,
  setOutboxPendingGauge,
  incrementOutboxLeaseRenew,
  incrementOutboxQuarantine,
  incrementOutboxLeaderAcquired,
  incrementOutboxLeaderLost,
} from './outboxMetrics.js'

export {
  syntheticProbeSuccessTotal,
  syntheticProbeFailureTotal,
  dbTxnDurationSeconds,
  dbTxnSavepoints,
  dbSlowQueriesTotal,
  dbSlowQueryDurationSeconds,
  registerSyntheticMetrics,
} from './customMetrics.js'
