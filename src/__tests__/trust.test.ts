import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import app from '../app'

// Mock the service
vi.mock('../services/reputationService.js', () => ({
  getTrustScore: vi.fn(),
}))

import { getTrustScore } from '../services/reputationService.js'

describe('Trust API ETag', () => {
  const address = '0x1234567890abcdef1234567890abcdef12345678'
  const mockScore = {
    address,
    score: 50,
    bondedAmount: '1000000000000000000',
    bondStart: '2023-01-01',
    attestationCount: 5,
  }

  // Helper to get a trust score
  const getTrustScoreRequest = (ifNoneMatch?: string) => {
    let req = request(app).get(`/api/trust/${address}`)
    if (ifNoneMatch) req = req.set('If-None-Match', ifNoneMatch)
    return req
  }

  it('should return 200 and an ETag for the first request', async () => {
    vi.mocked(getTrustScore).mockResolvedValue(mockScore)

    const response = await getTrustScoreRequest()
    expect(response.status).toBe(200)
    expect(response.headers).toHaveProperty('etag')
    expect(response.body).toEqual(mockScore)
  })

  it('should return 304 if If-None-Match matches the ETag', async () => {
    vi.mocked(getTrustScore).mockResolvedValue(mockScore)

    const firstResponse = await getTrustScoreRequest()
    const etag = firstResponse.headers.etag

    const secondResponse = await getTrustScoreRequest(etag)
    expect(secondResponse.status).toBe(304)
  })

  it('should return 200 with new ETag if score changes', async () => {
    vi.mocked(getTrustScore).mockResolvedValue(mockScore)

    const firstResponse = await getTrustScoreRequest()
    const etag1 = firstResponse.headers.etag

    const newScore = { ...mockScore, score: 60 }
    vi.mocked(getTrustScore).mockResolvedValue(newScore)

    const secondResponse = await getTrustScoreRequest(etag1)
    expect(secondResponse.status).toBe(200)
    expect(secondResponse.headers.etag).not.toBe(etag1)
  })
})
