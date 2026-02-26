import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from './index.js'

const validAddress = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

describe('API Endpoints', () => {
    describe('GET /api/attestations', () => {
        it.skip('should return paginated attestations with default limits', async () => {
            const response = await request(app).get('/api/attestations')
            expect(response.status).toBe(200)
            expect(response.body.data).toHaveLength(10)
            expect(response.body.pagination.hasMore).toBe(true)
            expect(response.body.pagination.nextOffset).toBe(10)
            expect(response.body.pagination.total).toBe(50)
        })

        it.skip('should respect custom limit and offset', async () => {
            const response = await request(app).get('/api/attestations?limit=5&offset=48')
            expect(response.status).toBe(200)
            expect(response.body.data).toHaveLength(2)
            expect(response.body.pagination.hasMore).toBe(false)
            expect(response.body.pagination.nextOffset).toBeNull()
        })
    })

    describe('GET /api/score-history', () => {
        it.skip('should return paginated score history with default limits', async () => {
            const response = await request(app).get('/api/score-history')
            expect(response.status).toBe(200)
            expect(response.body.data).toHaveLength(10)
            expect(response.body.pagination.hasMore).toBe(true)
        })

        it.skip('should calculate hasMore=false when reaching the end', async () => {
            const response = await request(app).get('/api/score-history?limit=10&offset=40')
            expect(response.status).toBe(200)
            expect(response.body.data).toHaveLength(5)
            expect(response.body.pagination.hasMore).toBe(false)
        })
    })

    describe('GET /api/disputes', () => {
        it.skip('should return paginated disputes with cursor', async () => {
            const response = await request(app).get('/api/disputes?cursor=20&limit=10')
            expect(response.status).toBe(200)
            expect(response.body.data).toHaveLength(5)
            expect(response.body.pagination.hasMore).toBe(false)
            expect(response.body.pagination.nextOffset).toBeNull()
        })
    })

    describe('GET /api/health', () => {
        it('should return ok status', async () => {
            const response = await request(app).get('/api/health')
            expect(response.status).toBe(200)
            expect(response.body).toMatchObject({ status: 'ok', service: 'credence-backend' })
        })
    })

    describe('GET /api/trust/:address', () => {
        it('should return trust payload for a valid address', async () => {
            const response = await request(app).get(`/api/trust/${validAddress}`)
            expect(response.status).toBe(200)
            expect(response.body.address).toBe(validAddress)
            expect(response.body).toHaveProperty('score')
        })

        it('should return 400 for invalid address', async () => {
            const response = await request(app).get('/api/trust/not-an-address')
            expect(response.status).toBe(400)
            expect(response.body).toHaveProperty('error')
        })
    })

    describe('GET /api/bond/:address', () => {
        it('should return bond payload for a valid address', async () => {
            const response = await request(app).get(`/api/bond/${validAddress}`)
            expect(response.status).toBe(200)
            expect(response.body.address).toBe(validAddress)
            expect(response.body).toHaveProperty('active')
        })

        it('should return 400 for invalid address', async () => {
            const response = await request(app).get('/api/bond/invalid')
            expect(response.status).toBe(400)
            expect(response.body).toHaveProperty('error')
        })
    })
})
