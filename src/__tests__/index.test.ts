import request from 'supertest';
import { app } from '../index.js';

describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/health');
      
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });
  });

  describe('GET /api/trust/:address', () => {
    it('should return trust score for a valid address', async () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
      const response = await request(app).get(`/api/trust/${address}`);
      
      expect(response.status).toBe(200);
      expect(response.body.address).toBe(address);
    });

    it('should handle different addresses', async () => {
      const address = '0x0000000000000000000000000000000000000001';
      const response = await request(app).get(`/api/trust/${address}`);
      
      expect(response.status).toBe(200);
      expect(response.body.address).toBe(address);
    });
  });
});
