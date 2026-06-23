/**
 * @file Integration tests for POST /api/reports report-type validation.
 *
 * Builds a minimal Express app with the validate middleware and
 * errorHandler to test that invalid report types are rejected at
 * the route level, without requiring a live database or Redis.
 */

import { describe, it, expect } from "vitest";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { validate } from "../../src/middleware/validate.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import {
  createReportBodySchema,
  type CreateReportBody,
  REPORT_TYPES,
} from "../../src/schemas/report.js";

/**
 * Build a self-contained Express app that mirrors the report route's
 * validation layer without the module-level DB/Redis dependencies.
 */
function createApp() {
  const app = express();
  app.use(express.json());

  app.post(
    "/api/reports",
    validate({ body: createReportBodySchema }),
    (req: Request, res: Response) => {
      const { type } = req.validated!.body! as CreateReportBody;
      res.status(202).json({ type, status: "queued" });
    },
  );

  app.use(errorHandler);
  return app;
}

describe("POST /api/reports — type validation", () => {
  const app = createApp();

  // Happy-path

  it.each(REPORT_TYPES)("returns 202 for allowed type: %s", async (type) => {
    const res = await request(app).post("/api/reports").send({ type });

    expect(res.status).toBe(202);
    expect(res.body.type).toBe(type);
    expect(res.body.status).toBe("queued");
  });

  // Invalid type

  it("returns 400 for an unknown report type", async () => {
    const res = await request(app)
      .post("/api/reports")
      .send({ type: "nonexistent_report" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 for an empty string type", async () => {
    const res = await request(app).post("/api/reports").send({ type: "" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when type is missing", async () => {
    const res = await request(app).post("/api/reports").send({});

    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty", async () => {
    const res = await request(app).post("/api/reports").send();

    expect(res.status).toBe(400);
  });

  it("returns 400 for a numeric type", async () => {
    const res = await request(app).post("/api/reports").send({ type: 42 });

    expect(res.status).toBe(400);
  });

  it("returns 400 for null type", async () => {
    const res = await request(app).post("/api/reports").send({ type: null });

    expect(res.status).toBe(400);
  });

  // Case sensitivity

  it("returns 400 for a case-mismatched type (mixed case)", async () => {
    const res = await request(app)
      .post("/api/reports")
      .send({ type: "Trust_Score_Summary" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for a case-mismatched type (uppercase)", async () => {
    const res = await request(app)
      .post("/api/reports")
      .send({ type: "BOND_AUDIT" });

    expect(res.status).toBe(400);
  });

  // Security: overly long strings

  it("returns 400 for an overly long type string", async () => {
    const res = await request(app)
      .post("/api/reports")
      .send({ type: "a".repeat(500) });

    expect(res.status).toBe(400);
  });

  // Strict mode: extra fields

  it("returns 400 when extra unknown fields are present", async () => {
    const res = await request(app)
      .post("/api/reports")
      .send({ type: "bond_audit", extraField: "unexpected" });

    expect(res.status).toBe(400);
  });
});
