#!/usr/bin/env node

import { dryRunMigration } from "../src/migrations/runner.js";
import { exit } from "process";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "\n⚠️  DATABASE_URL not set — skipping pending migration check.",
    );
    console.warn("   Set DATABASE_URL to enable migration checks.");
    exit(0);
  }

  try {
    const result = await dryRunMigration({
      skipPreflight: true,
      verbose: false,
    });

    if (!result.success) {
      if (
        result.error?.includes("ECONNREFUSED") ||
        result.error?.includes("database")?.toLowerCase()
      ) {
        console.warn(
          "\n⚠️  Could not connect to database — skipping migration check.",
        );
        exit(0);
      }
      console.warn(`\n⚠️  Migration check warning: ${result.error}`);
      exit(0);
    }

    if (result.applied.length === 0) {
      exit(0);
    }

    console.warn("");
    console.warn(
      "⚠️  ───────────────────────────────────────────────────────────────",
    );
    console.warn(
      `⚠️   ${result.applied.length} pending database migration(s) detected.`,
    );
    console.warn("⚠️   Run \x1b[1mnpm run migrate:dev\x1b[22m to apply them.");
    console.warn(
      "⚠️  ───────────────────────────────────────────────────────────────",
    );
    console.warn("");
    exit(0);
  } catch {
    console.warn(
      "\n⚠️  Could not check migrations — skipping. Ensure DATABASE_URL is set.",
    );
    exit(0);
  }
}

main();
