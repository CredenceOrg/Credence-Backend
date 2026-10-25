import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Pool, QueryResult } from "pg";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { instrumentQueryTracing } from "./pool.js";

describe("instrumentQueryTracing (OpenTelemetry Spans)", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider();

  beforeAll(() => {
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it("creates a db.query span with SQL and rowcount attributes on success", async () => {
    exporter.reset();

    const mockResult = { rows: [{ id: 1 }], rowCount: 1 } as unknown as QueryResult;
    const query = vi.fn().mockResolvedValue(mockResult);
    const fakePool = { query } as unknown as Pool;

    instrumentQueryTracing(fakePool, "api");

    const result = await fakePool.query("SELECT * FROM users WHERE id = $1", [1]);
    expect(result).toBe(mockResult);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.name).toBe("db.query");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes["db.system"]).toBe("postgresql");
    expect(span.attributes["db.statement"]).toBe("SELECT * FROM users WHERE id = $1");
    expect(span.attributes["db.pool"]).toBe("api");
    expect(span.attributes["db.row_count"]).toBe(1);
  });

  it("creates a db.query span and captures exceptions on failure", async () => {
    exporter.reset();

    const mockError = new Error("Unique constraint violation");
    const query = vi.fn().mockRejectedValue(mockError);
    const fakePool = { query } as unknown as Pool;

    instrumentQueryTracing(fakePool, "worker");

    await expect(fakePool.query("INSERT INTO users (id) VALUES ($1)", [1])).rejects.toThrow(
      "Unique constraint violation"
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.name).toBe("db.query");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("Unique constraint violation");
    expect(span.attributes["db.system"]).toBe("postgresql");
    expect(span.attributes["db.statement"]).toBe("INSERT INTO users (id) VALUES ($1)");
    expect(span.attributes["db.pool"]).toBe("worker");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("sanitizes exception attributes and does not leak parameters or detail", async () => {
    exporter.reset();

    const mockError = Object.assign(
      new Error('duplicate key value violates unique constraint "identities_email_key"'),
      {
        code: "23505",
        detail: "Key (email)=(a@b.c) already exists",
      }
    );
    const query = vi.fn().mockRejectedValue(mockError);
    const fakePool = { query } as unknown as Pool;

    instrumentQueryTracing(fakePool, "api");

    await expect(fakePool.query("INSERT INTO identities (email) VALUES ($1)", ["a@b.c"])).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0];
    const exceptionEvent = span.events.find((e) => e.name === "exception");
    expect(exceptionEvent).toBeDefined();
    expect(exceptionEvent!.attributes?.["exception.type"]).toBe("23505");
    expect(exceptionEvent!.attributes?.["exception.stacktrace"]).toBeUndefined();

    // Verify 'a@b.c' is not leaked anywhere in span attributes or event attributes
    const serializedAttributes = JSON.stringify(span.attributes);
    const serializedEvents = JSON.stringify(span.events);
    expect(serializedAttributes.includes("a@b.c")).toBe(false);
    expect(serializedEvents.includes("a@b.c")).toBe(false);
  });

  it("truncates message to 256 characters and statement to 1,024 characters", async () => {
    exporter.reset();

    const longMessage = "E".repeat(600);
    const mockError = new Error(longMessage);
    const query = vi.fn().mockRejectedValue(mockError);
    const fakePool = { query } as unknown as Pool;

    instrumentQueryTracing(fakePool, "replica");

    const longStatement = "SELECT " + "X".repeat(5000);
    await expect(fakePool.query(longStatement)).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.attributes["db.statement"]).toHaveLength(1024);
    expect(span.attributes["db.statement"]).toBe(longStatement.slice(0, 1024));

    const exceptionEvent = span.events.find((e) => e.name === "exception");
    expect(exceptionEvent).toBeDefined();
    const eventMessage = exceptionEvent!.attributes?.["exception.message"] as string;
    expect(eventMessage).toHaveLength(256);
    expect(eventMessage).toBe(longMessage.slice(0, 256));
  });
});