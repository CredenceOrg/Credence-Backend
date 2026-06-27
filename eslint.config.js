import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import {
  loggerSchemaValidation,
  loggerCallWithObjectRule,
} from "./src/observability/eslint-plugin-logger-schema.ts";

export default [
  {
    ignores: [
      "dist/**", 
      "coverage/**", 
      "node_modules/**", 
      "**/*.test.ts", 
      "**/*.spec.ts", 
      "src/test_fuzz_currency_whitelist.ts"
    ],
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/utils/logger.ts"],
    languageOptions: {
      parser: tsParser,
      sourceType: "module",
      ecmaVersion: "latest",
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "logger-schema": {
        rules: {
          "require-schema-context": loggerSchemaValidation,
          "unvalidated-logger-call": loggerCallWithObjectRule,
        },
      },
    },
    rules: {
      "no-console": "error",
      "logger-schema/require-schema-context": "warn",
      "logger-schema/unvalidated-logger-call": "warn",
    },
  },
  // Allow console only in logger implementation
  {
    files: ["src/utils/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
];
