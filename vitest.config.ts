import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup/reportTestEnv.ts"],
    include: [
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "src/**/__tests__/**/*.ts",
      "tests/integration/**/*.test.ts",
      "tests/jobs/**/*.test.ts",
      "tests/repositories/**/*.test.ts",
      "tests/repositories.test.ts",
      "tests/routes/**/*.test.ts",
      "tests/rbac/**/*.test.ts",
      "tests/rbac.test.ts",
      "monitoring/**/*.test.ts",
      "scripts/**/*.test.ts",
      // k6 load-test scripts (plain ESM JavaScript) and their boundary/recovery
      // suites. Those suites stub the `k6`, `k6/http` and `k6/execution`
      // built-ins with `vi.mock` factories, so no alias or installed k6 binary
      // is required to run them.
      "perf/**/*.test.js",
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/**/__tests__/**",
        "src/index.ts",
        // Type-only files – no executable code to cover
        "src/types/**",
        "src/**/*.d.ts",
        "src/**/types.ts",
        // Re-export barrel files – all they do is re-export
        'src/**/index.ts',
        // Generated SDK artifacts are validated via parity tests
        'src/sdk/errors.generated.ts',
        // Optional gRPC wrappers — not part of the HTTP SDK coverage gate
        'src/sdk/grpc/**',
        // Infrastructure utilities that require live dependencies
        "src/utils/**",
      ],
      thresholds: {
        statements: 40,
        branches: 40,
        functions: 40,
        lines: 40,
      },
    },
  },
  resolve: {
    extensions: [".ts", ".js", ".json"],
  },
});
