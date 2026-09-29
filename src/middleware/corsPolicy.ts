import cors from "cors";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { sendError, ErrorCode } from "../lib/errors.js";

/** Parse `CORS_ORIGIN` into a wildcard token or a trimmed allowlist. */
export function parseCorsOrigins(raw: string): "*" | string[] {
  if (raw === "*") {
    return "*";
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getRequestOrigin(req: Request): string | null {
  const protoHeader = req.headers["x-forwarded-proto"];
  const proto =
    typeof protoHeader === "string"
      ? protoHeader.split(",")[0].trim()
      : req.protocol;
  const hostHeader = req.headers["x-forwarded-host"] ?? req.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return null;
  }
  return `${proto}://${hostHeader.split(",")[0].trim()}`;
}

/** True when the browser sent an `Origin` header for a different site. */
export function isCrossOriginRequest(req: Request): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    return false;
  }
  const requestOrigin = getRequestOrigin(req);
  if (!requestOrigin) {
    return false;
  }
  return origin.toLowerCase() !== requestOrigin.toLowerCase();
}

/** Open policy — any origin may read responses (reflects request origin). */
export const corsOpen = cors({ origin: true });

/** Restricted policy — only origins listed in `CORS_ORIGIN` (or all in dev/test). */
export function corsRestricted(allowedOrigins: string): RequestHandler {
  const origins = parseCorsOrigins(allowedOrigins);
  return cors({
    origin: origins === "*" ? true : origins,
    credentials: origins !== "*",
  });
}

/** Same-origin only — cross-origin browser requests receive `cors_blocked`. */
export function corsSameOrigin(): RequestHandler {
  const passthrough = cors({ origin: false });
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isCrossOriginRequest(req)) {
      sendError(res, ErrorCode.CORS_BLOCKED);
      return;
    }
    passthrough(req, res, next);
  };
}

/**
 * Mount per-route CORS middleware on the application.
 *
 * See `docs/CORS_POLICY.md` for the route matrix and rationale.
 */
export function applyRouteCorsPolicy(app: Express, corsOrigin: string): void {
  const restricted = corsRestricted(corsOrigin);
  const sameOrigin = corsSameOrigin();

  // Open — health probes, JWKS, version metadata, CSP telemetry, signed downloads
  app.use("/.well-known", corsOpen);
  app.use("/api/health", corsOpen);
  app.use("/api/version", corsOpen);
  app.use("/csp-report", corsOpen);
  app.use("/api/reports/download", corsOpen);

  // Same-origin only — sensitive writes and admin surfaces
  app.use("/api/admin", sameOrigin);
  app.use("/api/payouts", sameOrigin);
  app.use("/api/evidence", sameOrigin);
  app.use("/api/auth", sameOrigin);
  app.use("/api/webhooks", sameOrigin);
  app.use("/api/disputes", sameOrigin);
  app.use("/api/dev", sameOrigin);
  app.use("/api/governance", sameOrigin);

  // Restricted — authenticated data routes (`/download` stays open; see above)
  app.use("/api/trust", restricted);
  app.use("/api/bond", restricted);
  app.use("/api/attestations", restricted);
  app.use("/api/bulk", restricted);
  app.use("/api/imports", restricted);
  app.use("/api/reports", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/download")) {
      corsOpen(req, res, next);
      return;
    }
    restricted(req, res, next);
  });
  app.use("/api/analytics", restricted);
  app.use("/api/orgs", restricted);
  app.use("/api/verification", restricted);
  app.use("/api/export", restricted);
}
