import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import app from './index.js';

describe('API Endpoints', () => {
    describe('GET /api/attestations', () => {
        it('should return paginated attestations with default limits', async () => {
            const response = await request(app).get('/api/attestations');
            expect(response.status).toBe(200);
            expect(response.body.data).toHaveLength(10);
            expect(response.body.pagination.hasMore).toBe(true);
            expect(response.body.pagination.nextOffset).toBe(10);
            expect(response.body.pagination.total).toBe(50);
        });

        it('should respect custom limit and offset', async () => {
            const response = await request(app).get('/api/attestations?limit=5&offset=48');
            expect(response.status).toBe(200);
            expect(response.body.data).toHaveLength(2); // Only 2 remaining out of 50
            expect(response.body.pagination.hasMore).toBe(false);
            expect(response.body.pagination.nextOffset).toBeNull();
        });
    });

    describe('GET /api/score-history', () => {
        it('should return paginated score history with default limits', async () => {
            const response = await request(app).get('/api/score-history');
            expect(response.status).toBe(200);
            expect(response.body.data).toHaveLength(10);
            expect(response.body.pagination.hasMore).toBe(true);
        });

        it('should calculate hasMore=false when reaching the end', async () => {
            const response = await request(app).get('/api/score-history?limit=10&offset=40');
            expect(response.status).toBe(200);
            expect(response.body.data).toHaveLength(5); // 45 total
            expect(response.body.pagination.hasMore).toBe(false);
        });
    });

    describe('GET /api/disputes', () => {
        it('should return paginated disputes with cursor', async () => {
            const response = await request(app).get('/api/disputes?cursor=20&limit=10');
            expect(response.status).toBe(200);
            expect(response.body.data).toHaveLength(5); // 25 total
            expect(response.body.pagination.hasMore).toBe(false);
            expect(response.body.pagination.nextOffset).toBeNull();
        });
    });

    describe('GET /api/health', () => {
        it('should return ok status', async () => {
            const response = await request(app).get('/api/health');
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ status: 'ok', service: 'credence-backend' });
        });
    });

    describe('GET /api/trust/:address', () => {
        it('should return default trust payload', async () => {
            const response = await request(app).get('/api/trust/0x123');
            expect(response.status).toBe(200);
            expect(response.body.address).toBe('0x123');
            expect(response.body.score).toBe(0);
        });
    });

    describe('GET /api/bond/:address', () => {
        it('should return default bond payload', async () => {
            const response = await request(app).get('/api/bond/0x456');
            expect(response.status).toBe(200);
            expect(response.body.address).toBe('0x456');
            expect(response.body.active).toBe(false);
        });
    });
});
