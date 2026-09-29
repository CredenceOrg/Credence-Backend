# Structured Logging Guide

**Audience: contributors** — engineers writing or reviewing code in this repository.

This document covers when to use each log level, how PII redaction works, the reserved key schema, request-lifecycle tracing, and the ESLint rules that enforce these conventions.

Related docs:
- [Observability & Request Tracing](observability.md) — `req.log`, request-scoped context, metrics
- [OBSERVABILITY.md](OBSERVABILITY.md) — Prometheus metrics, Grafana dashboard, alert PromQL

---

## Table of Contents

1. [Core principles](#1-core-principles)
2. [Log levels — when to use each](#2-log-levels--when-to-use-each)
3. [Request lifecycle tracing](#3-request-lifecycle-tracing)
4. [Reserved keys](#4-reserved-keys)
5. [PII redaction rules](#5-pii-redaction-rules)
6. [Schema-aware logging (LogEventType)](#6-schema-aware-logging-logeventtype)
7. [ESLint enforcement](#7-eslint-enforcement)
8. [LOG_LEVEL environment variable](#8-log_level-environment-variable)
9. [Adding a new event type](#9-adding-a-new-event-type)
10. [Quick reference — do / do not](#10-quick-reference--do--do-not)

---

## 1. Core principles

1. **Use the structured logger.** Never use `console.log` / `console.error` directly in application code; they bypass redaction and schema validation.
2. **Log context, not prose.** The `message` field should be a stable, searchable event name (e.g. `bond_withdrawal_initiated`). Put variable data in the JSON payload, not in the message string.
3. **Redact before you serialize.** Redaction runs _before_ `JSON.stringify()` so PII never appears in serialized logs or Node.js heap dumps.
4. **Fail-secure.** Unknown fields are _dropped_, not passed through. If a field must appear in the log, add it explicitly to the schema for its `LogEventType`.

---

## 2. Log levels — when to use each

### `debug`

Use `debug` for verbose, developer-facing information that is only useful when actively investigating a problem. Debug lines are silenced in production by default (see [LOG_LEVEL](#8-log_level-environment-variable)).

**Use `debug` when:**
- Tracing the internal state of a complex algorithm step-by-step
- Logging every retry attempt during local development
- Dumping intermediate values while chasing a race condition
- Showing which cache branch was taken

**Do not use `debug` when:**
- The information is useful in production incidents — use `info` or `warn`
- It would emit on every request in the hot path — add a feature flag or sample rate

```typescript
// Good: step-by-step tracing of cursor pagination logic
logger.debug({ message: "cursor_page_resolved", cursor, offset, limit });

// Good: cache internals during local debugging
logger.debug({ message: "cache_miss", key: cacheKey, ttl });
```

---

### `info`

Use `info` for normal, observable business events. Info logs should read like an audit trail of what the system did: one line per meaningful action, always at the outermost boundary of that action.

**Use `info` when:**
- A request was received and handled successfully
- A background job started, completed, or was skipped
- A Horizon listener picked up an on-chain event
- A webhook was delivered
- A migration ran successfully

**Do not use `info` when:**
- The event happens dozens of times per second per request (e.g. every SQL statement) — that is `debug` territory
- Something went wrong — use `warn` or `error`

```typescript
// In a route handler — use req.log so request context is automatic
app.post("/api/attestations", async (req, res) => {
  req.log.info(
    { message: "attestation_create_requested", subjectAddress: req.body.subject },
    { eventType: LogEventType.GENERIC_INFO }
  );
  // ... handler logic ...
  req.log.info(
    { message: "attestation_created", attestationId: result.id },
    { eventType: LogEventType.GENERIC_INFO }
  );
  res.status(201).json(result);
});

// In a background job — use module-level logger
logger.info(
  { message: "score_snapshot_job_completed", snapshotCount: 42, durationMs: 310 },
  { eventType: LogEventType.GENERIC_INFO }
);
```

---

### `warn`

Use `warn` for recoverable problems that the system handled but that an operator should be aware of. A warn does not mean the request failed; it means something unexpected happened and the system compensated.

**Use `warn` when:**
- A retry was needed (first or second attempt; escalate to `error` on exhaustion)
- A feature flag was missing and a default was applied
- A dependency returned a non-fatal degraded response
- A rate-limit threshold was approached (not yet breached)
- A config value was out of the recommended range
- A request carried a deprecated header or API version

**Do not use `warn` when:**
- The situation is fully expected behavior — use `info`
- The system cannot continue without human intervention — use `error`

```typescript
// Soroban RPC retry — warn on attempts, error on exhaustion
logger.warn(
  {
    message: "soroban_rpc_retry",
    provider: "horizon-mainnet",
    attempt: 2,
    maxAttempts: 5,
    delayMs: 800,
    code: "NETWORK_ERROR",
  },
  { eventType: LogEventType.SOROBAN_RETRY }
);

// Deprecated header still accepted
req.log.warn(
  { message: "deprecated_header_received", header: "x-legacy-tenant-id" },
  { eventType: LogEventType.GENERIC_WARN }
);
```

---

### `error`

Use `error` for failures that require operator attention or that caused a request to fail. Every `error` line should ideally map to an on-call alert or ticket.

**Use `error` when:**
- A request returned 500
- A background job failed after all retries were exhausted
- A database query threw an unrecoverable error
- A webhook delivery was exhausted
- An unexpected exception was caught at the top-level error handler

**Do not use `error` when:**
- The failure is a client mistake (400-level) — use `warn` or `info`
- Retries are still available — use `warn` until the final attempt

```typescript
// Caught exception in the error handler middleware
logger.error(
  { message: "unhandled_request_error", method: req.method, path: req.path, statusCode: 500 },
  err,                                   // second argument: the Error object
  { eventType: LogEventType.HTTP_ERROR }
);

// Webhook exhausted
logger.error(
  {
    message: "webhook_delivery_exhausted",
    provider: subscription.url,
    attempts: 5,
    errorCode: "TIMEOUT",
  },
  { eventType: LogEventType.WEBHOOK_DELIVERY_EXHAUSTED }
);
```

The `logger.error()` signature accepts an optional second `Error` argument which is serialized to `{ error: string, stack: string }` — both fields are included in the `GENERIC_ERROR` and `HTTP_ERROR` schemas.

---

### Level summary table

| Level   | Visible in production (default) | Who cares? | Example events |
|---------|----------------------------------|------------|----------------|
| `debug` | No (`LOG_LEVEL=info`)            | Developer actively debugging | cursor resolved, cache branch taken |
| `info`  | Yes                              | Operator, auditor | request handled, job completed, event received |
| `warn`  | Yes                              | On-call engineer (no page) | retry attempt, deprecated header, degraded dependency |
| `error` | Yes                              | On-call engineer (page) | 500 response, job exhausted, DB failure |

---

## 3. Request lifecycle tracing

Every inbound HTTP request is assigned three IDs by `requestIdMiddleware` (`src/middleware/requestId.ts`):

| ID | Header | Purpose |
|----|--------|---------|
| `requestId` | `X-Request-ID` | Unique per HTTP call; returned in the response header |
| `correlationId` | `X-Correlation-ID` | Persists across service calls; propagated downstream |
| `traceId` | `X-Trace-ID` | End-to-end trace across all hops |

These IDs are stored in an `AsyncLocalStorage` context (`tracingContext` in `src/utils/logger.ts`) and are automatically appended to every log line emitted during that request — including logs inside services and repositories that are called synchronously from the handler.

### Propagation into async jobs and webhooks

`AsyncLocalStorage` only follows the call stack of a single in-process async chain. It does **not** survive the request handler returning — so anything that is deferred (a domain event written to the transactional outbox, a scheduled job, a webhook delivered minutes later by a different process) needs the correlation id handed to it explicitly and restored when that later work actually runs.

Three helpers in `src/utils/logger.ts` implement this hand-off:

| Function | Used at | Purpose |
|----------|---------|---------|
| `getActiveCorrelationIds()` | The moment work is handed off (e.g. `OutboxEventEmitter.emit`) | Snapshot `correlationId`/`requestId` out of the current context so they can travel with the deferred work |
| `runWithCorrelationIds(ids, fn)` | The moment the deferred work actually runs (e.g. `OutboxPublisher.processEvent`, `deliverWebhook`, `JobScheduler.runJob`) | Re-install those ids into a fresh `AsyncLocalStorage` context for the duration of `fn`, so `logger` calls inside it are tagged correctly |
| `sanitizeCorrelationId(value)` | Any point a correlation id is about to leave the process (an outbound HTTP header) or has entered it from an external caller | Strips anything outside `[A-Za-z0-9._:-]` and truncates to 128 chars, so a value that round-tripped through a client-supplied header or a database row can't be used for HTTP header/log injection |

Concretely, for the transactional outbox and webhook pipeline:

1. **Emit** (`src/db/outbox/emitter.ts`): when a domain event is written to the outbox inside a request, `OutboxEventEmitter` captures the active `correlationId` (alongside the existing OTel `traceId`/`spanId`) and persists it on the `event_outbox` row (`correlation_id` column).
2. **Publish** (`src/db/outbox/publisher.ts`): when `OutboxPublisher` later picks up that row — potentially seconds or minutes afterward, on any worker replica — it restores the stored `correlationId` via `runWithCorrelationIds` for the duration of the call into the registered `EventPublisher`, so logs (and metrics/error messages) from that publish attempt are tagged with the id of the request that originally caused it.
3. **Webhook delivery** (`src/services/webhooks/{service,delivery}.ts`): `WebhookEventPublisher` forwards the correlation id into `WebhookService.emit`, which passes it to `deliverWebhook`. There it is (a) sanitized and sent to the receiving endpoint as an `X-Correlation-Id` header, and (b) used to restore the tracing context around the HTTP call and its retries, so delivery logs are tagged too.
4. **Scheduled jobs** (`src/jobs/scheduler.ts`): scheduled jobs have no originating request, so `JobScheduler` generates a fresh correlation id for each run and wraps `job.run()` in `runWithCorrelationIds`. Any outbox events the job emits during that run inherit the same id (via step 1), so a single job run can still be traced end-to-end through anything it triggers.

A single request (or job run) can therefore be traced through: `HTTP request → domain event emitted to outbox → outbox published later by a worker → webhook delivered to a third party`, all tagged with the same `correlationId` in structured logs, and echoed to the receiving webhook endpoint via `X-Correlation-Id` so it can correlate on its side too.

Security note: because a correlation id can originate from an external, untrusted `x-correlation-id` request header and later round-trip through a database row before being reused, every point where it crosses a boundary (an outbound webhook header, or re-entry into `AsyncLocalStorage`) sanitizes it first with `sanitizeCorrelationId`.

### Using `req.log` inside handlers and middleware

Inside Express route handlers and middleware, always use `req.log` instead of the module-level `logger`. `req.log` is a `RequestLogger` pre-bound to the request's `AsyncLocalStorage` context, so `requestId`, `correlationId`, `tenant`, and `actor` appear in the output without any extra work.

```typescript
import { Request, Response } from "express";
import { LogEventType } from "../observability/logSchemas.js";

export async function getBondHandler(req: Request, res: Response) {
  const { address } = req.params;

  req.log.info(
    { message: "bond_read_requested", address },
    { eventType: LogEventType.GENERIC_INFO }
  );

  try {
    const bond = await bondService.getByAddress(address);

    req.log.info(
      { message: "bond_read_success", address, bondId: bond.id },
      { eventType: LogEventType.GENERIC_INFO }
    );

    res.json(bond);
  } catch (err) {
    req.log.error(
      { message: "bond_read_failed", address, statusCode: 500 },
      err as Error,
      { eventType: LogEventType.HTTP_ERROR }
    );
    res.status(500).json({ error: "internal_error" });
  }
}
```

By following these rules, we ensure that our logs remain a powerful and secure tool for the entire team.

## See Also

- **[Log Retention Policy](LOG_RETENTION.md)** — how long each log type is kept and where.
