import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import {
  loggerSchemaValidation,
  loggerCallWithObjectRule,
} from "./src/observability/eslint-plugin-logger-schema.ts";

export default [
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts"],
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
      "logger-schema/require-schema-context": "warn",
      "logger-schema/unvalidated-logger-call": "warn",
    },
  },
];
