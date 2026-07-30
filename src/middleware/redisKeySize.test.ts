import { describe, it, expect } from 'vitest'
import { register, recordRedisKeySize } from './metrics.js'

describe('redis_key_size_bytes metric', () => {
  it('is exposed on the Prometheus registry with a namespace label', async () => {
    recordRedisKeySize('attestation', 2048)

    const metricsStr = await register.metrics()

    expect(metricsStr).toContain('# HELP redis_key_size_bytes')
    expect(metricsStr).toContain('# TYPE redis_key_size_bytes histogram')
    expect(metricsStr).toContain('redis_key_size_bytes_bucket{le="4096",namespace="attestation"}')
    expect(metricsStr).toContain('redis_key_size_bytes_sum{namespace="attestation"}')
    expect(metricsStr).toContain('redis_key_size_bytes_count{namespace="attestation"}')
  })

  it('records a mega-key (a large observation) in the highest overflow bucket', async () => {
    // 6 MB — bigger than the largest finite bucket (4 MB) — should fall into +Inf.
    recordRedisKeySize('bulk_export', 6 * 1024 * 1024)

    const metricsStr = await register.metrics()

    expect(metricsStr).toContain('redis_key_size_bytes_bucket{le="+Inf",namespace="bulk_export"}')
  })

  it('keeps per-namespace observations separate (low label cardinality by design)', async () => {
    recordRedisKeySize('trust', 512)
    recordRedisKeySize('bond', 512)

    const metricsStr = await register.metrics()

    expect(metricsStr).toContain('namespace="trust"')
    expect(metricsStr).toContain('namespace="bond"')
  })
})
