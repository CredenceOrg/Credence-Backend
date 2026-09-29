import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const JEST_BIN = path.join(PROJECT_ROOT, "node_modules", "jest", "bin", "jest.js");

type JestConfigOutput = {
  configs: Array<{
    roots: string[];
    testMatch: string[];
    globals?: {
      "ts-jest"?: {
        tsconfig?: { module?: string };
      };
    };
    transform: Array<[string, string, Record<string, unknown>]>;
  }>;
  globalConfig: {
    coverageThreshold?: {
      global?: Record<string, number>;
    };
  };
};

function runJest(...args: string[]) {
  const result = spawnSync(process.execPath, [JEST_BIN, "--showConfig", ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 5 * 1024 * 1024,
  });

  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function readResolvedConfig(stdout: string): JestConfigOutput {
  return JSON.parse(stdout) as JestConfigOutput;
}

function expectGlobalCoverageThresholds(output: JestConfigOutput) {
  expect(output.globalConfig.coverageThreshold?.global).toEqual({
    branches: 95,
    functions: 95,
    lines: 95,
    statements: 95,
  });
}

describe("Jest configuration boundaries", () => {
  it("requires explicit selection when both Jest config files exist", () => {
    const result = runJest();

    expect(result.error).toBeUndefined();
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Multiple configurations found");
    expect(result.stderr).toContain("jest.config.js");
    expect(result.stderr).toContain("jest.config.ts");
  });

  it("resolves the JavaScript config and its CommonJS compatibility boundary", () => {
    const result = runJest("--config", "jest.config.js");

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const output = readResolvedConfig(result.stdout);
    const config = output.configs[0];

    expect(config.roots).toEqual([path.join(PROJECT_ROOT, "src")]);
    expect(config.testMatch).toEqual([
      "**/__tests__/**/*.ts",
      "**/?(*.)+(spec|test).ts",
    ]);
    expectGlobalCoverageThresholds(output);
    // This keeps ts-jest output compatible with Jest's CommonJS execution in this ESM package.
    expect(config.globals?.["ts-jest"]?.tsconfig?.module).toBe("CommonJS");
    expect(
      config.transform.some(([, transformer]) => transformer.includes("ts-jest")),
    ).toBe(true);
  });

  it("resolves the TypeScript config without the JavaScript config's override", () => {
    const result = runJest("--config", "jest.config.ts");

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const output = readResolvedConfig(result.stdout);
    const config = output.configs[0];

    expect(config.roots).toEqual([PROJECT_ROOT]);
    expect(config.testMatch).toEqual(["**/tests/**/*.test.ts"]);
    expectGlobalCoverageThresholds(output);
    expect(config.globals?.["ts-jest"]?.tsconfig?.module).toBeUndefined();
  });
});
