import { describe, it, expect, beforeEach } from 'vitest'
import client from 'prom-client'
import {
  DOWNSTREAM_RPC_LATENCY_BUCKETS_MS,
  downstreamRpcLatencyHistogram,
  recordDownstreamRpcLatency,
  registerRpcLatencyMetrics,
} from './rpcLatencyMetrics.js'

describe('Downstream RPC latency metrics', () => {
  beforeEach(() => {
    downstreamRpcLatencyHistogram.reset()
  })

  it('uses the documented millisecond buckets', () => {
    expect(DOWNSTREAM_RPC_LATENCY_BUCKETS_MS).toEqual([25, 50, 100, 250, 500, 1000])
  })

  it('registers a histogram labelled by provider and op', async () => {
    const registry = new client.Registry()
    registerRpcLatencyMetrics(registry)

    recordDownstreamRpcLatency('soroban', 'getContractData', 40)

    const metricsStr = await registry.metrics()
    expect(metricsStr).toContain('# TYPE downstream_rpc_latency_milliseconds histogram')
    expect(metricsStr).toContain(
      'downstream_rpc_latency_milliseconds_count{provider="soroban",op="getContractData"} 1',
    )
  })

  it('distributes observations across the configured buckets', async () => {
    const registry = new client.Registry()
    registerRpcLatencyMetrics(registry)

    // 40ms falls in the le="50" bucket and every larger bucket, but not le="25".
    recordDownstreamRpcLatency('soroban', 'getEvents', 40)

    const metricsStr = await registry.metrics()
    // Parse bucket counts independently of label ordering across prom-client versions.
    const bucketCount = (le: string): number | null => {
      const line = metricsStr.split('\n').find(
        (l) =>
          l.startsWith('downstream_rpc_latency_milliseconds_bucket') &&
          l.includes('op="getEvents"') &&
          l.includes(`le="${le}"`),
      )
      return line ? Number(line.trim().split(/\s+/).pop()) : null
    }

    expect(bucketCount('25')).toBe(0)
    expect(bucketCount('50')).toBe(1)
    expect(bucketCount('1000')).toBe(1)
  })

  it('separates series by provider and op label', async () => {
    const registry = new client.Registry()
    registerRpcLatencyMetrics(registry)

    recordDownstreamRpcLatency('soroban', 'getContractData', 30)
    recordDownstreamRpcLatency('soroban', 'getEvents', 30)

    const metricsStr = await registry.metrics()
    expect(metricsStr).toContain(
      'downstream_rpc_latency_milliseconds_count{provider="soroban",op="getContractData"} 1',
    )
    expect(metricsStr).toContain(
      'downstream_rpc_latency_milliseconds_count{provider="soroban",op="getEvents"} 1',
    )
  })
})
