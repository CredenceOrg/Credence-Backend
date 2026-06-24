# Backup Restore Verification

This document describes the weekly backup restore drill process that verifies the integrity of database backups by restoring them to an isolated schema and running validation checks.

## Overview

The restore drill is designed to:
1. Retrieve the latest database snapshot
2. Restore it to an isolated `restore_verify` schema
3. Verify row counts match the production database for key tables
4. Perform checksum validation
5. Clean up the restore schema
6. Emit metrics for monitoring and alerting

## Key Files

- **`scripts/restore-verify.ts`**: The main script that drives the restore drill
- **`src/jobs/backupVerifyMetrics.ts`**: Prometheus metrics definitions
- **`.github/workflows/restore-drill.yml`**: GitHub Actions workflow for weekly execution
- **`docs/backup-restore.md`**: This documentation

## Metrics

The drill emits the following Prometheus metrics:

| Metric Name                      | Type       | Description                                                                 |
|----------------------------------|------------|-----------------------------------------------------------------------------|
| `backup_restore_verify_seconds`  | Histogram  | Duration of the entire restore and verification process in seconds          |
| `backup_restore_failed_total`    | Counter    | Total number of restore failures, labeled by the step where the failure occurred |

## Running Locally

To run the restore drill locally:

```bash
npm run drill:restore
```

## Tables Verified

The drill verifies the following tables:
- `identities`
- `bonds`
- `attestations`
- `payouts`
- `audit_logs`

## Security Considerations

- The drill uses an isolated schema to avoid affecting production data
- A dedicated database role with minimal permissions should be used in production
- The restore process should not have network access to production systems

## Edge Cases Handled

- Snapshot older than schema migrations (will fail verification)
- Missing tables in the restored snapshot
- Corrupted dump files
