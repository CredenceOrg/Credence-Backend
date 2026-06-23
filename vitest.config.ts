import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "src/**/__tests__/**/*.ts",
      "tests/integration/**/*.test.ts",
      "tests/routes/**/*.test.ts",
      "monitoring/**/*.test.ts",
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
        // Infrastructure utilities that require live dependencies
        "src/utils/**",
      ],
      thresholds: {
        statements: 40,
        branches: 40,
        functions: 40,
        lines: 40,
        'src/sdk/**': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
  resolve: {
    extensions: [".ts", ".js", ".json"],
  },
});
