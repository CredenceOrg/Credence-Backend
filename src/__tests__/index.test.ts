import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index.js';

describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
    });
  });

  describe('GET /api/trust/:address', () => {
    it('should return trust score for an address', async () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
      const response = await request(app).get(`/api/trust/${address}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        address,
        score: 0,
        bondedAmount: '0',
        bondStart: null,
        attestationCount: 0,
      });
    });

    it('should handle different addresses', async () => {
      const address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
      const response = await request(app).get(`/api/trust/${address}`);

      expect(response.status).toBe(200);
      expect(response.body.address).toBe(address);
    });
  });

  describe('GET /api/bond/:address', () => {
    it('should return bond status for an address', async () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
      const response = await request(app).get(`/api/bond/${address}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('address');
      expect(response.body).toHaveProperty('bondedAmount');
    });
  });

  describe('404 Handling', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/api/unknown');

      expect(response.status).toBe(404);
    });
  });
});

describe('JSON Parsing', () => {
  it('should handle valid JSON in request body', async () => {
    const response = await request(app)
      .post('/api/bulk/verify')
      .set('X-API-Key', 'test-enterprise-key-12345')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          addresses: [
            'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ',
          ],
        })
      );

    expect(response.status).toBe(200);
  });
});
