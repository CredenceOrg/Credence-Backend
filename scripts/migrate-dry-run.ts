#!/usr/bin/env node

/**
 * Dry-run migration CLI
 *
 * Prints the SQL that would be executed by the next migration without actually running it.
 * Useful for reviewing changes before deployment.
 */

import { dryRunMigration } from "../src/migrations/runner.js";
import { pathToFileURL } from "node:url";

export async function main(): Promise<void> {
  try {
    const result = await dryRunMigration({
      skipPreflight: true,
      verbose: true,
    });

    if (!result.success) {
      console.error(`\n❌ Dry-run failed: ${result.error}`);
      process.exit(1);
      return;
    }

    if (result.applied.length === 0) {
      console.log("\n✅ No pending migrations");
      process.exit(0);
      return;
    }

    console.log(
      `\n✅ Dry-run completed. ${result.applied.length} migration(s) would be applied.`,
    );
    console.log("Migrations to be applied:");
    result.applied.forEach((migration, index) => {
      console.log(`  ${index + 1}. ${migration}`);
    });
    process.exit(0);
  } catch (error) {
    console.error(`❌ Error during dry-run: ${error}`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests).
const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main();
}
