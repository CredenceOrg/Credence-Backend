#!/usr/bin/env tsx
/**
 * SBOM validation gate.
 *
 * Validates a CycloneDX SBOM (produced by `npm run sbom:generate`) so that
 * every merge is guaranteed to ship a well-formed, non-empty software
 * bill of materials. Surfaces a typed, discriminated-union result instead of
 * panicking, so callers (CLI + tests) can branch on the failure reason.
 *
 * Threat mitigated: without a generated-and-validated SBOM on every merge,
 * a compromised or accidentally-introduced (transitive) dependency can enter
 * the production graph with no machine-readable inventory and no gate that
 * fails closed. This check makes the supply-chain inventory a build gate.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** Discriminated-union error codes surfaced by {@link validateSbom}. */
export type SbomValidationErrorCode =
  | "INVALID_JSON"
  | "SCHEMA_MISMATCH"
  | "EMPTY_COMPONENTS";

export type SbomValidationResult =
  | { ok: true; specVersion: string; componentCount: number }
  | { ok: false; code: SbomValidationErrorCode; message: string };

/**
 * Minimal CycloneDX SBOM schema. We intentionally validate only the fields the
 * gate depends on (format marker, spec version, component inventory) and allow
 * the rest of the document through untouched.
 */
const componentSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  type: z.string().optional(),
});

const sbomSchema = z.object({
  bomFormat: z.literal("CycloneDX"),
  specVersion: z.string().min(1),
  components: z.array(componentSchema),
});

/**
 * Validates an already-parsed SBOM object. Pure and side-effect free so it can
 * be unit-tested (including the negative path) without touching the filesystem.
 */
export function validateSbom(raw: unknown): SbomValidationResult {
  const parsed = sbomSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "SCHEMA_MISMATCH",
      message: `SBOM does not match the CycloneDX schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    };
  }

  if (parsed.data.components.length === 0) {
    return {
      ok: false,
      code: "EMPTY_COMPONENTS",
      message:
        "SBOM contains zero components — generation likely failed or produced an empty inventory.",
    };
  }

  return {
    ok: true,
    specVersion: parsed.data.specVersion,
    componentCount: parsed.data.components.length,
  };
}

/**
 * Reads an SBOM file from disk and validates it. Wraps JSON parse failures in
 * the same typed result shape as schema failures.
 */
export function validateSbomFile(path: string): SbomValidationResult {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_JSON",
      message: `Unable to read SBOM file at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_JSON",
      message: `SBOM file at ${path} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return validateSbom(json);
}

export function runCli(argv = process.argv.slice(2)): number {
  const path = argv[0] ?? "sbom.json";
  const result = validateSbomFile(path);

  if (!result.ok) {
    console.error(`sbom-validate: [${result.code}] ${result.message}`);
    return 1;
  }

  console.log(
    `sbom-validate: OK — CycloneDX ${result.specVersion}, ${result.componentCount} components (${path}).`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(runCli());
}
