#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Drop, recreate, and re-migrate the local test database.
 *
 * Requires a running Postgres instance (e.g. docker compose -f docker-compose.test.yml up -d).
 * Uses TEST_DATABASE_URL when set; otherwise the default from src/config/testDatabase.ts.
 */

import dotenv from 'dotenv'
import { resetTestDatabase } from '../src/db/resetTestDatabase.js'

dotenv.config()

async function main(): Promise<void> {
  const { databaseUrl, migrationApplied } = await resetTestDatabase()

  console.log(`✅ Test database reset at ${databaseUrl}`)
  if (migrationApplied.length === 0) {
    console.log('Migrations applied (fresh schema)')
  } else {
    console.log(`Applied ${migrationApplied.length} migration(s)`)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`❌ Failed to reset test database: ${message}`)
  process.exit(1)
})
