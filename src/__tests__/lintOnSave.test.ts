/**
 * Tests for the `npm run lint` and `npm run lint:fix` scripts.
 *
 * Temp files are written inside `src/` so that ESLint's flat-config lookup
 * finds `eslint.config.js` at the project root — the same behaviour as when a
 * developer saves a real source file in VS Code.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Project root: src/__tests__/ is two directories below the repo root
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

const ESLINT_BIN = path.join(
  PROJECT_ROOT,
  "node_modules",
  "eslint",
  "bin",
  "eslint.js",
);

// ---------------------------------------------------------------------------
// Helper: run ESLint on a specific file using the same invocation as the npm
// scripts (`node --import tsx ./node_modules/eslint/bin/eslint.js`).
// ---------------------------------------------------------------------------
function runEslintOn(
  target: string,
  fix = false,
): { exitCode: number; stdout: string; stderr: string } {
  const args = [
    "--import",
    "tsx",
    ESLINT_BIN,
    target,
    ...(fix ? ["--fix"] : []),
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Temp file management — files live inside src/ so ESLint finds the config
// ---------------------------------------------------------------------------
const tmpFiles: string[] = [];

function writeTempSrc(name: string, content: string): string {
  const filePath = path.join(PROJECT_ROOT, "src", name);
  fs.writeFileSync(filePath, content, "utf8");
  tmpFiles.push(filePath);
  return filePath;
}

afterAll(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already deleted */
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lint:fix npm script", () => {
  it("package.json declares the lint:fix script with --fix flag", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(pkg.scripts?.["lint:fix"]).toBeDefined();
    expect(pkg.scripts!["lint:fix"]).toMatch(/--fix/);
  });

  it("happy path: exits 0 on a TypeScript file with no lint violations", () => {
    const cleanFile = writeTempSrc(
      "__tmp_lint_clean.ts",
      [
        "// Lint-clean TypeScript file",
        "export const add = (a: number, b: number): number => a + b;",
        "",
      ].join("\n"),
    );

    const { exitCode } = runEslintOn(cleanFile);
    expect(exitCode).toBe(0);
  });

  it("happy path: --fix (lint:fix) is idempotent on a clean file and exits 0", () => {
    const cleanFile = writeTempSrc(
      "__tmp_lint_idempotent.ts",
      [
        "// File with no violations — --fix must be idempotent",
        "export const greet = (name: string): string => `Hello, ${name}!`;",
        "",
      ].join("\n"),
    );

    const before = fs.readFileSync(cleanFile, "utf8");
    const { exitCode } = runEslintOn(cleanFile, /* fix */ true);
    const after = fs.readFileSync(cleanFile, "utf8");

    expect(exitCode).toBe(0);
    expect(after).toBe(before); // idempotent: no change to a clean file
  });

  it("failure mode: exits non-zero on an unfixable lint error, even with --fix", () => {
    // no-console is "error" in eslint.config.js and is not auto-fixable.
    const violatingFile = writeTempSrc(
      "__tmp_lint_violating.ts",
      [
        "// File with an unfixable lint error (no-console)",
        "export function logIt(msg: string): void {",
        "  console.log(msg);",
        "}",
        "",
      ].join("\n"),
    );

    const { exitCode, stdout, stderr } = runEslintOn(violatingFile, /* fix */ true);

    expect(exitCode).not.toBe(0);
    const combined = stdout + stderr;
    expect(combined).toMatch(/no-console|console/i);
  });

  it("check-only mode: exits non-zero on a violation without modifying the file", () => {
    const originalContent = [
      "export function bad(msg: string): void {",
      "  console.error(msg);",
      "}",
      "",
    ].join("\n");
    const violatingFile = writeTempSrc("__tmp_lint_checkonly.ts", originalContent);

    const { exitCode } = runEslintOn(violatingFile, /* fix */ false);

    expect(exitCode).not.toBe(0);
    // File must be unchanged in check-only mode
    expect(fs.readFileSync(violatingFile, "utf8")).toBe(originalContent);
  });
});

describe(".vscode configuration", () => {
  it("settings.json exists and enables ESLint fix-on-save", () => {
    const settingsPath = path.join(PROJECT_ROOT, ".vscode", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf8"),
    ) as Record<string, unknown>;

    const codeActions = settings["editor.codeActionsOnSave"] as
      | Record<string, string>
      | undefined;
    expect(codeActions?.["source.fixAll.eslint"]).toBe("explicit");
  });

  it("settings.json enables flat-config mode", () => {
    const settingsPath = path.join(PROJECT_ROOT, ".vscode", "settings.json");
    const settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf8"),
    ) as Record<string, unknown>;

    expect(settings["eslint.useFlatConfig"]).toBe(true);
  });

  it("extensions.json recommends the ESLint VS Code extension", () => {
    const extPath = path.join(PROJECT_ROOT, ".vscode", "extensions.json");
    expect(fs.existsSync(extPath)).toBe(true);

    const ext = JSON.parse(fs.readFileSync(extPath, "utf8")) as {
      recommendations?: string[];
    };
    expect(ext.recommendations).toContain("dbaeumer.vscode-eslint");
  });
});
