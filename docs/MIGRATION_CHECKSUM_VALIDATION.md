# Migration Checksum Validation

This document describes startup checksum validation for database migrations, which prevents silent drift when applied migration files are modified after deployment.

## Problem

The migration runner (`node-pg-migrate`) records **which** migrations have been applied in `pgmigrations`, but not **what** those files contained. If someone edits an already-applied migration file, the database schema and the migration history can diverge without any obvious signal at deploy time.

## Solution

At startup, the backend:

1. Reads applied migration names from `pgmigrations`
2. Computes SHA-256 checksums of the corresponding on-disk migration files
3. Compares them against records in `migration_checksums`
4. **Rejects startup** when a mismatch is detected

Checksums are recorded automatically when new migrations are applied via `runMigration()`, and missing records are bootstrapped on first startup after adoption.

## Configuration

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `MIGRATION_CHECKSUM_VALIDATE` | Set to `false` to disable startup validation | enabled |
| `MIGRATION_CHECKSUM_BOOTSTRAP` | Set to `false` to fail instead of seeding missing checksum records | enabled |
| `MIGRATIONS_DIR` | Directory containing migration source files | `dist/migrations` when present, else `src/migrations` |

Startup validation runs only when a database connection is available (`DB_URL` / pool). It is skipped in test mode (`NODE_ENV=test`).

## Deployment

1. Run migrations as usual (`npm run migrate:dev` or CI pipeline)
2. Start the application — checksum validation runs before traffic is accepted
3. On first startup after this feature, missing checksum records are bootstrapped from current files

### Manual backfill

If bootstrap is disabled (`MIGRATION_CHECKSUM_BOOTSTRAP=false`), seed checksums before starting the app:

```bash
DATABASE_URL=postgres://... tsx scripts/backfill-migration-checksums.ts
```

## Failure modes

| Condition | Behaviour |
| --------- | --------- |
| Checksum mismatch | Fatal startup error with migration name and expected/actual digests |
| Missing migration file | Fatal startup error — applied migration not found on disk |
| Missing checksum record (bootstrap off) | Fatal startup error — run backfill script |
| `migration_checksums` table absent | Validation skipped (run migrations first) |

## Security notes

- Checksums use SHA-256 over raw migration file bytes
- Validation executes before the server accepts traffic (alongside KeyManager bootstrap)
- Disabling validation (`MIGRATION_CHECKSUM_VALIDATE=false`) should be limited to local development

## Related

- [Migration Safety Guide](./MIGRATION_SAFETY.md)
- [Migration Guardrails](./MIGRATION_GUARDRAILS.md)
- Implementation: `src/migrations/checksumValidation.ts`
