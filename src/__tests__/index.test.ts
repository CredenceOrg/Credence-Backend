import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../index.js";

describe("API Endpoints", () => {
  describe("GET /api/health", () => {
    it("should return health status", async () => {
      const response = await request(app).get("/api/health");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
      expect(response.body.service).toBe("credence-backend");
    });
  });

  describe("GET /api/trust/:address", () => {
    it("should return trust score for an address", async () => {
      const address =
        "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ";
      const response = await request(app).get(`/api/trust/${address}`);
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'credence-backend',
      })
      expect(response.body).toHaveProperty('dependencies')
    })
  })

  describe('GET /api/trust/:address', () => {
    it('should return trust score for an address', async () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
      const response = await request(app).get(`/api/trust/${address}`)

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        address,
        score: 0,
        bondedAmount: "0",
        bondStart: null,
        attestationCount: 0,
      });
    });
      })
    })

    it('should handle different addresses', async () => {
      const address = '0x0000000000000000000000000000000000000001'
      const response = await request(app).get(`/api/trust/${address}`)

    it("should handle different addresses", async () => {
      const address =
        "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ";
      const response = await request(app).get(`/api/trust/${address}`);

      expect(response.status).toBe(200);
      expect(response.body.address).toBe(address);
    });
  });
  describe('GET /api/bond/:address', () => {
    it('should return bond status for an address', async () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
      const response = await request(app).get(`/api/bond/${address}`)

  describe("GET /api/bond/:address", () => {
    it("should return 400 for invalid address format", async () => {
      const address =
        "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ";
      const response = await request(app).get(`/api/bond/${address}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Invalid address format/);
    });
    it('should handle different addresses', async () => {
      const address = '0x0000000000000000000000000000000000000001'
      const response = await request(app).get(`/api/bond/${address}`)

    it("should return 404 for valid address with no bond", async () => {
      const address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
      const response = await request(app).get(`/api/bond/${address}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/No bond record found/);
    });
  });

  describe("404 Handling", () => {
    it("should return 404 for unknown routes", async () => {
      const response = await request(app).get("/api/unknown");

      expect(response.status).toBe(404);
    });
  });
});

describe("JSON Parsing", () => {
  it("should handle valid JSON in request body", async () => {
    const response = await request(app)
      .post("/api/bulk/verify")
      .set("X-API-Key", "test-enterprise-key-12345")
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify({
          addresses: [
            "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
          ],
        }),
      );

    expect(response.status).toBe(200);
  });
});
