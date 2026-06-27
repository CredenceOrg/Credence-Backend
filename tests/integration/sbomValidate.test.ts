import { describe, expect, it } from "vitest";
import { validateSbom } from "../../scripts/sbom-validate.js";

const validSbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  components: [
    { type: "library", name: "zod", version: "4.3.6" },
    { type: "library", name: "express", version: "4.19.2" },
  ],
};

describe("SBOM validation gate", () => {
  it("accepts a well-formed, non-empty CycloneDX SBOM", () => {
    const result = validateSbom(validSbom);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.specVersion).toBe("1.5");
      expect(result.componentCount).toBe(2);
    }
  });

  // Negative test: a missing format marker must fail the gate with a typed
  // error rather than slipping through. This fails before the validator exists.
  it("rejects a document that is not a CycloneDX SBOM", () => {
    const result = validateSbom({ specVersion: "1.5", components: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SCHEMA_MISMATCH");
    }
  });

  // Negative test: an empty component inventory means generation silently
  // produced nothing — the supply-chain inventory we depend on is absent.
  it("rejects an SBOM with zero components", () => {
    const result = validateSbom({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EMPTY_COMPONENTS");
    }
  });

  it("rejects a malformed component entry with a typed error", () => {
    const result = validateSbom({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [{ version: "1.0.0" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SCHEMA_MISMATCH");
    }
  });
});
