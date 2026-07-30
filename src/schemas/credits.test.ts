import { describe, it, expect } from 'vitest'
import { creditsLowWebhookPayloadSchema } from './credits.js'

describe('creditsLowWebhookPayloadSchema', () => {
  it('accepts a valid payload', () => {
    const result = creditsLowWebhookPayloadSchema.parse({
      orgId: '00000000-0000-0000-0000-000000000001',
      creditsRemaining: 50,
      threshold: 100,
      endpoint: '/test',
      requestId: 'req-1',
    })

    expect(result.creditsRemaining).toBe(50)
    expect(result.threshold).toBe(100)
  })

  it('rejects invalid orgId', () => {
    expect(() =>
      creditsLowWebhookPayloadSchema.parse({
        orgId: 'not-a-uuid',
        creditsRemaining: 50,
        threshold: 100,
      }),
    ).toThrow()
  })

  it('rejects negative creditsRemaining', () => {
    expect(() =>
      creditsLowWebhookPayloadSchema.parse({
        orgId: '00000000-0000-0000-0000-000000000001',
        creditsRemaining: -1,
        threshold: 100,
      }),
    ).toThrow()
  })
})
