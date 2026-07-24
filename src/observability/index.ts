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

export { registerPoolMetrics } from './poolMetrics.js'
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
} from './outboxMetrics.js'

export {
  syntheticProbeSuccessTotal,
  syntheticProbeFailureTotal,
  dbTxnDurationSeconds,
  dbTxnSavepoints,
  registerSyntheticMetrics,
} from './customMetrics.js'
