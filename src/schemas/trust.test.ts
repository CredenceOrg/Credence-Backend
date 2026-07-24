import { describe, it, expect } from "vitest";
import {
  trustExplainQuerySchema,
  trustPathParamsSchema,
  trustQuerySchema,
} from "./trust.js";

const validAddress = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

describe("trustPathParamsSchema", () => {
  it("accepts valid address", () => {
    expect(trustPathParamsSchema.parse({ address: validAddress })).toEqual({
      address: validAddress,
    });
  });

  it("rejects invalid address", () => {
    expect(
      trustPathParamsSchema.safeParse({ address: "invalid" }).success,
    ).toBe(false);
  });
});

describe("trustQuerySchema", () => {
  it("accepts empty object", () => {
    expect(trustQuerySchema.parse({})).toEqual({});
  });
});

describe("trustExplainQuerySchema", () => {
  it("accepts numeric snapshotId strings", () => {
    expect(trustExplainQuerySchema.parse({ snapshotId: "5" })).toEqual({
      snapshotId: 5,
    });
  });

  it("rejects missing snapshotId", () => {
    expect(trustExplainQuerySchema.safeParse({}).success).toBe(false);
  });

  it("rejects invalid snapshotId values", () => {
    expect(
      trustExplainQuerySchema.safeParse({ snapshotId: "abc" }).success,
    ).toBe(false);
  });
});
