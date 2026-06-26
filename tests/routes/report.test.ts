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

import { ReportStorageService } from "../../src/services/reportStorage.js";
import reportRouter from "../../src/routes/report.js";

// App is built once for the entire suite.
// The signing secret is injected via vitest.config.ts#setupFiles before this module loads.
const downloadApp = express();
downloadApp.use("/api/reports", reportRouter);

describe("GET /api/reports/download/:key validation", () => {
  let reportStorage: ReportStorageService;

  beforeEach(() => {
    ReportStorageService.reset();
    reportStorage = new ReportStorageService();
  });

  afterEach(() => {
    ReportStorageService.reset();
  });

  it("returns 200 and serves artifact with correct headers for valid signed URL", async () => {
    const key = reportStorage.makeKey("test-tenant", "job-123");
    async function* stream() {
      yield Buffer.from("mock-pdf-content", "utf-8");
    }
    await reportStorage.uploadStream(key, stream());

    const { url } = reportStorage.generateSignedUrl(key);
    const parsed = new URL(url);

    const res = await request(downloadApp).get(parsed.pathname + parsed.search);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="job-123.pdf"');
    expect(res.body.toString("utf8")).toBe("mock-pdf-content");
  });

  it("returns 401 when the signed URL has expired", async () => {
    const key = reportStorage.makeKey("test-tenant", "job-exp");
    async function* stream() { yield Buffer.from("data", "utf-8"); }
    await reportStorage.uploadStream(key, stream());

    // Generate valid URL and modify expires query param (which breaks signature,
    // but the implementation checks expires first anyway, or checking both).
    // Better way: create another instance with short TTL.
    const strictStorage = new ReportStorageService({ ttlMs: -1000 });
    const { url } = strictStorage.generateSignedUrl(key);
    const parsed = new URL(url);

    const res = await request(downloadApp).get(parsed.pathname + parsed.search);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 when the signature is tampered", async () => {
    const key = reportStorage.makeKey("test-tenant", "job-tamper");
    async function* stream() { yield Buffer.from("data", "utf-8"); }
    await reportStorage.uploadStream(key, stream());

    const { url } = reportStorage.generateSignedUrl(key);
    const parsed = new URL(url);
    parsed.searchParams.set("signature", "deadbeef");

    const res = await request(downloadApp).get(parsed.pathname + parsed.search);
    expect(res.status).toBe(401);
  });

  it("returns 401 for a tampered key request", async () => {
    const keyA = reportStorage.makeKey("tenant", "a");
    const keyB = reportStorage.makeKey("tenant", "b");

    async function* stream() { yield Buffer.from("data", "utf-8"); }
    await reportStorage.uploadStream(keyA, stream());
    await reportStorage.uploadStream(keyB, stream());

    // Signed URL for A
    const { url } = reportStorage.generateSignedUrl(keyA);
    const parsed = new URL(url);

    // Request using key B but with signature for A
    const tamperedPath = `/api/reports/download/${encodeURIComponent(keyB)}`;
    const res = await request(downloadApp).get(tamperedPath + parsed.search);
    
    expect(res.status).toBe(401);
  });

  it("returns 400 when missing signature", async () => {
    const key = reportStorage.makeKey("t1", "job");
    const { url } = reportStorage.generateSignedUrl(key);
    const parsed = new URL(url);
    parsed.searchParams.delete("signature");

    const res = await request(downloadApp).get(parsed.pathname + parsed.search);
    expect(res.status).toBe(400);
  });

  it("returns 400 when missing expires", async () => {
    const key = reportStorage.makeKey("t1", "job");
    const { url } = reportStorage.generateSignedUrl(key);
    const parsed = new URL(url);
    parsed.searchParams.delete("expires");

    const res = await request(downloadApp).get(parsed.pathname + parsed.search);
    expect(res.status).toBe(400);
  });


  it("handles URL decoding of the :key param correctly (spaces and special chars)", async () => {
    // The route param /:key is a single Express segment, so the key must not contain
    // literal slashes. We test that percent-encoded spaces and other safe chars round-trip.
    const key = "reports_t1_job+report (2026).pdf";
    async function* stream() { yield Buffer.from("decoded-content", "utf-8"); }
    await reportStorage.uploadStream(key, stream());

    // generateSignedUrl percent-encodes the key into the URL path
    const { url } = reportStorage.generateSignedUrl(key);
    const parsed = new URL(url);

    const res = await request(downloadApp).get(parsed.pathname + parsed.search);
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe("decoded-content");
  });
});
