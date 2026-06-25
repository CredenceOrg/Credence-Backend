#!/usr/bin/env node

/**
 * Dry-run migration CLI
 *
 * Prints the SQL that would be executed by the next migration without actually running it.
 * Useful for reviewing changes before deployment.
 */

import { dryRunMigration } from "../src/migrations/runner.js";
import { exit } from "process";

async function main() {
  try {
    const result = await dryRunMigration({
      skipPreflight: true,
      verbose: true,
    });

    if (!result.success) {
      console.error(`\n❌ Dry-run failed: ${result.error}`);
      exit(1);
    }

    if (result.applied.length === 0) {
      console.log("\n✅ No pending migrations");
      exit(0);
    }

    console.log(
      `\n✅ Dry-run completed. ${result.applied.length} migration(s) would be applied.`,
    );
    console.log("Migrations to be applied:");
    result.applied.forEach((migration, index) => {
      console.log(`  ${index + 1}. ${migration}`);
    });
    exit(0);
  } catch (error) {
    console.error(`❌ Error during dry-run: ${error}`);
    exit(1);
  }
}

main();
