/**
 * Downstream RPC latency metrics.
 *
 * Records the wall-clock latency of outbound RPC calls to downstream
 * providers (e.g. Soroban) as a Prometheus histogram, labelled by the
 * provider and the operation (op) invoked.
 */

import client from 'prom-client'

/**
 * Histogram buckets (in milliseconds) for downstream RPC latency.
 *
 * Defined once here and reused everywhere so the bucket boundaries stay
 * consistent across the metric definition, tests, and documentation.
 */
export const DOWNSTREAM_RPC_LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000]

/**
 * Histogram of downstream RPC call latency in milliseconds.
 *
 * Cardinality is bounded by the number of providers (e.g. soroban) times the
 * number of distinct operations per provider (e.g. getContractData, getEvents).
 */
export const downstreamRpcLatencyHistogram = new client.Histogram({
  name: 'downstream_rpc_latency_milliseconds',
  help: 'Downstream RPC call latency in milliseconds, labelled by provider and op',
  labelNames: ['provider', 'op'],
  buckets: DOWNSTREAM_RPC_LATENCY_BUCKETS_MS,
})

/**
 * Records a single downstream RPC call's latency.
 *
 * @param provider Downstream provider label, e.g. "soroban".
 * @param op       Operation / RPC method invoked, e.g. "getContractData".
 * @param durationMs Wall-clock duration of the call in milliseconds.
 */
export function recordDownstreamRpcLatency(
  provider: string,
  op: string,
  durationMs: number,
): void {
  downstreamRpcLatencyHistogram.observe({ provider, op }, durationMs)
}

/**
 * Registers the downstream RPC latency metrics with the provided registry.
 */
export function registerRpcLatencyMetrics(registry: client.Registry): void {
  registry.registerMetric(downstreamRpcLatencyHistogram)
}
