#!/usr/bin/env node

import { dryRunMigration } from "../src/migrations/runner.js";
import { exit } from "process";

export async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "\n⚠️  DATABASE_URL not set — skipping pending migration check.",
    );
    console.warn("   Set DATABASE_URL to enable migration checks.");
    return 0;
  }

  try {
    const result = await dryRunMigration({
      skipPreflight: true,
      verbose: false,
    });

    if (!result.success) {
      if (
        result.error?.includes("ECONNREFUSED") ||
        result.error?.toLowerCase().includes("database")
      ) {
        console.warn(
          "\n⚠️  Could not connect to database — skipping migration check.",
        );
        return 0;
      }
      console.warn(`\n⚠️  Migration check warning: ${result.error}`);
      return 0;
    }

    if (result.applied.length === 0) {
      return 0;
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
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      "\n⚠️  Could not check migrations — skipping. Ensure DATABASE_URL is set.",
    );
    console.warn(`   Details: ${message}`);
    return 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => exit(code));
}
