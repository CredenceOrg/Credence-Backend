import { describe, it, expect } from "vitest";
import {
  createReportBodySchema,
  reportTypeSchema,
  REPORT_TYPES,
} from "./report.js";

describe("reportTypeSchema", () => {
  it.each(REPORT_TYPES)("accepts allowed type: %s", (type) => {
    expect(reportTypeSchema.parse(type)).toBe(type);
  });

  it("rejects an unknown type string", () => {
    expect(reportTypeSchema.safeParse("foobar").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(reportTypeSchema.safeParse("").success).toBe(false);
  });

  it("rejects a numeric value", () => {
    expect(reportTypeSchema.safeParse(42).success).toBe(false);
  });

  it("rejects null", () => {
    expect(reportTypeSchema.safeParse(null).success).toBe(false);
  });

  it("rejects undefined", () => {
    expect(reportTypeSchema.safeParse(undefined).success).toBe(false);
  });

  it("is case-sensitive (rejects uppercase variant)", () => {
    expect(reportTypeSchema.safeParse("Trust_Score_Summary").success).toBe(
      false,
    );
  });

  it("is case-sensitive (rejects all-uppercase variant)", () => {
    expect(reportTypeSchema.safeParse("BOND_AUDIT").success).toBe(false);
  });

  it("rejects an overly long string", () => {
    const longString = "a".repeat(500);
    expect(reportTypeSchema.safeParse(longString).success).toBe(false);
  });
});

describe("createReportBodySchema", () => {
  it("accepts a valid body with an allowed type", () => {
    expect(
      createReportBodySchema.parse({ type: "trust_score_summary" }),
    ).toEqual({
      type: "trust_score_summary",
    });
  });

  it("accepts each allowed report type", () => {
    for (const type of REPORT_TYPES) {
      expect(createReportBodySchema.parse({ type })).toEqual({ type });
    }
  });

  it("rejects a body with an unknown type", () => {
    const result = createReportBodySchema.safeParse({ type: "invalid_report" });
    expect(result.success).toBe(false);
  });

  it("rejects a body with missing type field", () => {
    const result = createReportBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a body with empty string type", () => {
    const result = createReportBodySchema.safeParse({ type: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a body with numeric type", () => {
    const result = createReportBodySchema.safeParse({ type: 123 });
    expect(result.success).toBe(false);
  });

  it("rejects a body with null type", () => {
    const result = createReportBodySchema.safeParse({ type: null });
    expect(result.success).toBe(false);
  });

  it("rejects extra unknown fields (.strict())", () => {
    const result = createReportBodySchema.safeParse({
      type: "bond_audit",
      extraField: "unexpected",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an overly long type string", () => {
    const result = createReportBodySchema.safeParse({ type: "x".repeat(500) });
    expect(result.success).toBe(false);
  });
});
