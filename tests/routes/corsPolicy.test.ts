import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import {
  applyRouteCorsPolicy,
  corsOpen,
  corsRestricted,
  corsSameOrigin,
  isCrossOriginRequest,
} from "../../src/middleware/corsPolicy.js";
import { createHealthRouter } from "../../src/routes/health.js";
import { createVersionRouter } from "../../src/routes/version.js";

function appWithCorsPolicy(corsOrigin = "*") {
  const app = express();
  app.use(express.json());
  applyRouteCorsPolicy(app, corsOrigin);
  return app;
}

describe("CORS per-route policy enforcement", () => {
  it("rejects cross-origin POST to same-origin-only /api/payouts with cors_blocked", async () => {
    const app = appWithCorsPolicy();
    app.post("/api/payouts/", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app)
      .post("/api/payouts/")
      .set("Origin", "https://evil.com")
      .set("Host", "api.credence.io");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("code", "cors_blocked");
  });

  it("allows cross-origin GET to open /api/health/live", async () => {
    const app = appWithCorsPolicy();
    app.use("/api/health", createHealthRouter());

    const res = await request(app)
      .get("/api/health/live")
      .set("Origin", "https://any-origin.com")
      .set("Host", "api.credence.io");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://any-origin.com",
    );
  });

  it("allows cross-origin GET to open /api/version", async () => {
    const app = appWithCorsPolicy();
    app.use("/api/version", createVersionRouter());

    const res = await request(app)
      .get("/api/version")
      .set("Origin", "https://dashboard.credence.io")
      .set("Host", "api.credence.io");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://dashboard.credence.io",
    );
  });

  it("does not block signed download paths with cors_blocked for cross-origin GET", async () => {
    const app = appWithCorsPolicy();
    app.get("/api/reports/download/:key", (_req, res) => {
      res.status(404).json({ code: "not_found" });
    });

    const res = await request(app)
      .get("/api/reports/download/test-key?expires=9999999999&signature=valid")
      .set("Origin", "https://dashboard.credence.io")
      .set("Host", "api.credence.io");

    expect(res.status).not.toBe(403);
    expect(res.body.code).not.toBe("cors_blocked");
  });

  it("reflects trusted origin on restricted routes when CORS_ORIGIN is set", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/trust",
      corsRestricted("https://trusted.app"),
    );
    app.get("/api/trust/:address", (_req, res) => {
      res.status(200).json({ score: 1 });
    });

    const res = await request(app)
      .get("/api/trust/GABC123")
      .set("Origin", "https://trusted.app")
      .set("Host", "api.credence.io");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://trusted.app");
  });

  it("blocks cross-origin admin POST before route handler runs", async () => {
    const app = appWithCorsPolicy();
    app.post("/api/admin/users", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app)
      .post("/api/admin/users")
      .set("Origin", "https://evil.com")
      .set("Host", "api.credence.io");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("code", "cors_blocked");
  });
});

describe("isCrossOriginRequest", () => {
  it("returns false when Origin header is absent", () => {
    const req = {
      protocol: "https",
      headers: { host: "api.credence.io" },
    } as express.Request;

    expect(isCrossOriginRequest(req)).toBe(false);
  });

  it("returns true when Origin differs from request host", () => {
    const req = {
      protocol: "https",
      headers: {
        host: "api.credence.io",
        origin: "https://evil.com",
      },
    } as express.Request;

    expect(isCrossOriginRequest(req)).toBe(true);
  });
});

describe("corsSameOrigin middleware", () => {
  it("passes through requests without an Origin header", async () => {
    const app = express();
    app.use("/api/auth", corsSameOrigin());
    app.post("/api/auth/login", (_req, res) => {
      res.status(401).json({ code: "unauthorized" });
    });

    const res = await request(app)
      .post("/api/auth/login")
      .set("Host", "api.credence.io");

    expect(res.status).toBe(401);
    expect(res.body.code).not.toBe("cors_blocked");
  });
});

describe("corsOpen middleware", () => {
  it("sets Access-Control-Allow-Origin for preflight OPTIONS", async () => {
    const app = express();
    app.use("/api/health", corsOpen);
    app.options("/api/health/live", (_req, res) => {
      res.sendStatus(204);
    });

    const res = await request(app)
      .options("/api/health/live")
      .set("Origin", "https://probe.example")
      .set("Access-Control-Request-Method", "GET")
      .set("Host", "api.credence.io");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://probe.example",
    );
  });
});
