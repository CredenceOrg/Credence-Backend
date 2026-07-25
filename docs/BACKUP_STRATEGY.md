# Backup Strategy: WAL + PITR

**Audience:** Operators / Platform engineers running Credence Backend in production.

This document describes the Write-Ahead Logging (WAL) and Point-In-Time Recovery (PITR) posture for the Credence PostgreSQL database. It covers retention, restore procedures, and verification cadence.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PRODUCTION DATABASE CLUSTER                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  Primary (Writer)                                                           │
│  ├── WAL segments → local pg_wal/                                           │
│  ├── WAL archiving → S3/GCS via `archive_command`                          │
│  └── Base backup (pg_basebackup) → S3/GCS (weekly)                         │
│                                                                             │
│  Replica (Reader) — async streaming replication                             │
│  └── Receives WAL via replication slot                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    WAL archive + base backups
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OBJECT STORAGE (S3 / GCS)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  s3://credence-backups/                                                     │
│  ├── basebackups/     ← Weekly pg_basebackup (physical)                     │
│  │   ├── base_2025-07-21_000000.tar.gz                                      │
│  │   └── ...                                                                  │
│  └── wal/             ← Continuous WAL archive (wal-g / pgBackRest /        │
│      ├── 000000010000000100000001.gz                                        │
│      └── ...                                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key properties**

| Property | Value | Rationale |
|----------|-------|-----------|
| WAL level | `replica` | Required for streaming replication + logical decoding |
| Archive mode | `on` | Continuous WAL shipping to object storage |
| Archive command | `wal-g wal-push %p` (or `pgbackrest --stanza=main archive-push %p`) | Proven tooling, compression, encryption, retry |
| Base backup frequency | Weekly (Sunday 02:00 UTC) | RPO ≤ 7 days for full restore; PITR covers intra-week |
| WAL retention | 14 days (2 base backups + WAL) | Covers 2 full backup cycles; supports PITR to any second in window |
| Replication slots | 1 physical slot per replica | Prevents WAL removal before replica catches up |

---

## WAL Configuration (PostgreSQL 16)

### Primary `postgresql.conf` (managed via ConfigMap / operator)

```conf
# --- Write-Ahead Logging ---
wal_level = replica                    # replica | logical
max_wal_senders = 10
max_replication_slots = 10

# --- Archiving ---
archive_mode = on
archive_command = 'wal-g wal-push %p'  # or pgbackrest --stanza=main archive-push %p
archive_timeout = 60s                  # force segment switch every 60s if idle

# --- Checkpoint / WAL sizing ---
checkpoint_timeout = 15min
max_wal_size = 4GB                     # bounds pg_wal/ growth
min_wal_size = 1GB
checkpoint_completion_target = 0.9

# --- Replication slots (prevent WAL removal before replica catches up) ---
primary_slot_name = 'credence_replica_slot'
```

### Verify WAL archiving is working

```bash
# Check archive status (should show 'ARCHIVED' for recent segments)
psql -c "SELECT * FROM pg_stat_archiver;"

# Inspect last 5 WAL segments in object storage
aws s3 ls s3://credence-backups/wal/ --recursive | tail -5
```

---

## Retention Policy

| Artifact | Retention | Rationale |
|----------|-----------|-----------|
| Base backups (weekly) | 14 days (2 generations) | Full restore fallback; covers 2 PITR windows |
| WAL segments | 14 days (aligned with oldest base backup) | Enables PITR to any second within window |
| Restore verification artifacts (schema `restore_verify`) | Ephemeral (dropped after each drill) | No long-term storage needed |

**RPO / RTO targets**

| Scenario | RPO | RTO (target) |
|----------|-----|--------------|
| Point-in-time recovery (within 14 days) | ≤ 1 second (last archived WAL) | < 30 min (restore base + replay WAL) |
| Full cluster loss (new cluster from base backup) | ≤ 7 days (last weekly base backup) | < 60 min |

---

## Restore Procedures

> **Prerequisites:** `wal-g` (or `pgbackrest`) installed, AWS/GCS credentials with read access to `s3://credence-backups/`, target PostgreSQL 16 instance with empty data directory.

### A. Point-In-Time Recovery (PITR) — Target: specific timestamp

Use when: data corruption, accidental `DELETE`, bad migration, need to inspect state at `2025-07-20 14:32:00 UTC`.

```bash
# 1. Stop target PostgreSQL (if running)
systemctl stop postgresql

# 2. Clear data directory (DANGEROUS — ensure correct cluster!)
rm -rf /var/lib/postgresql/16/main/*

# 3. Fetch latest base backup BEFORE target time
wal-g backup-fetch /var/lib/postgresql/16/main LATEST \
  --target-time="2025-07-20 14:32:00+00"

# 4. Create recovery.signal + restore_command
cat > /var/lib/postgresql/16/main/recovery.signal <<'EOF'
EOF

cat > /var/lib/postgresql/16/main/postgresql.auto.conf <<'EOF'
restore_command = 'wal-g wal-fetch "%f" "%p"'
recovery_target_time = '2025-07-20 14:32:00+00'
recovery_target_action = 'promote'
primary_slot_name = ''      # disable replication slot on new primary
EOF

# 5. Fix permissions and start
chown -R postgres:postgres /var/lib/postgresql/16/main
chmod 700 /var/lib/postgresql/16/main
systemctl start postgresql

# 6. Verify promotion
psql -c "SELECT pg_is_in_recovery();"  # should return 'f'
psql -c "SELECT now();"                 # should be ~target time
```

**Key flags**

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `recovery_target_time` | ISO8601 timestamp | Stop replay at this exact moment |
| `recovery_target_action = 'promote'` | | Become writable primary after recovery |
| `primary_slot_name = ''` | | Don't try to use old replication slot |

### B. Full Restore (Latest Base Backup + All WAL)

Use when: spinning up a new staging cluster, DR region failover, or PITR window exceeded.

```bash
wal-g backup-fetch /var/lib/postgresql/16/main LATEST

cat > /var/lib/postgresql/16/main/recovery.signal <<'EOF'
EOF

cat > /var/lib/postgresql/16/main/postgresql.auto.conf <<'EOF'
restore_command = 'wal-g wal-fetch "%f" "%p"'
recovery_target_action = 'promote'
primary_slot_name = ''
EOF

chown -R postgres:postgres /var/lib/postgresql/16/main
systemctl start postgresql
```

### C. Standalone Verify Drill (Non-Production)

This is the **weekly restore-verify drill** documented in [docs/backup-restore.md](backup-restore.md). It restores to an **isolated schema** (`restore_verify`) in the *same* cluster and compares row counts / checksums.

```bash
# Runs via GitHub Actions weekly + `npm run drill:restore` locally
npm run drill:restore
```

**What it validates**

- Base backup is restorable (not corrupted)
- WAL replay works up to current LSN
- Row counts match production for core tables: `identities`, `bonds`, `attestations`, `payouts`, `audit_logs`
- Schema checksums match (column definitions, types, constraints)

**Metrics emitted** (Prometheus)

| Metric | Type | Labels |
|--------|------|--------|
| `backup_restore_verify_seconds` | Histogram | — |
| `backup_restore_failed_total` | Counter | `step` ∈ {`snapshot`, `restore`, `row_count`, `checksum`, `cleanup`} |

Alert rule (see [docs/monitoring.md](monitoring.md#alert-rules)):

```yaml
- alert: BackupRestoreVerifyFailed
  expr: increase(backup_restore_failed_total[1h]) > 0
  for: 0m
  labels:
    severity: critical
    team: platform
  annotations:
    summary: "Weekly backup restore verification failed"
    runbook: "docs/RUNBOOK.md#backup-restore-verification-failed"
```

---

## Verification Cadence

| Check | Frequency | Automation | Owner |
|-------|-----------|------------|-------|
| WAL archive lag (`pg_stat_archiver.failed_count > 0`) | Continuous (Prometheus scrape) | Alert on `pg_stat_archiver_failed_total > 0` | On-call |
| Replica lag (`pg_replication_slots.restart_lsn` vs `pg_current_wal_lsn()`) | Continuous | Alert on `pg_replication_lag_bytes > 100MB` | On-call |
| Base backup completes successfully | Weekly (Sunday 02:00 UTC) | CI workflow `backup-base.yml` (see below) | Platform |
| Restore-verify drill (schema compare) | Weekly (Monday 03:00 UTC) | GitHub Actions `restore-drill.yml` + `npm run drill:restore` | Platform |
| Full PITR restore test (staging cluster) | Quarterly | Manual runbook: [docs/RUNBOOK.md#quarterly-pitr-drill](RUNBOOK.md#quarterly-pitr-drill) | Platform |

### GitHub Actions: Weekly Base Backup

```yaml
# .github/workflows/backup-base.yml
name: Weekly Base Backup
on:
  schedule:
    - cron: '0 2 * * 0'  # Sunday 02:00 UTC
  workflow_dispatch:

jobs:
  backup:
    runs-on: ubuntu-latest
    permissions:
      id-token: write      # for OIDC to AWS
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/credence-backup-writer
          aws-region: us-east-1
      - name: Install wal-g
        run: |
          curl -L https://github.com/wal-g/wal-g/releases/download/v3.0.0/wal-g.linux-amd64.tar.gz | tar xz
          sudo mv wal-g /usr/local/bin/
      - name: Run base backup
        env:
          WALG_S3_PREFIX: s3://credence-backups
          PGDATA: /var/lib/postgresql/16/main
          PGHOST: ${{ secrets.PG_HOST }}
          PGUSER: ${{ secrets.PG_USER }}
          PGPASSWORD: ${{ secrets.PG_PASSWORD }}
        run: |
          wal-g backup-push /var/lib/postgresql/16/main
      - name: Verify backup listed
        run: wal-g backup-list
```

### GitHub Actions: Weekly Restore Drill

```yaml
# .github/workflows/restore-drill.yml
name: Weekly Restore Verification Drill
on:
  schedule:
    - cron: '0 3 * * 1'  # Monday 03:00 UTC
  workflow_dispatch:

jobs:
  drill:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: credence
          POSTGRES_USER: credence
          POSTGRES_PASSWORD: credence
        ports: ["5432:5432"]
        options: --health-cmd "pg_isready -U credence" --health-interval 10s --health-timeout 5s --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Run restore-verify drill
        env:
          DB_URL: postgresql://credence:credence@localhost:5432/credence
        run: npm run drill:restore
```

---

## Operational Runbooks (Cross-links)

| Scenario | Runbook |
|----------|---------|
| WAL archiving stalled / `failed_count` increasing | [RUNBOOK.md#wal-archiving-stalled](RUNBOOK.md#wal-archiving-stalled) |
| Replica lag > 100 MB | [RUNBOOK.md#replica-lag](RUNBOOK.md#replica-lag) |
| Weekly base backup failed | [RUNBOOK.md#base-backup-failed](RUNBOOK.md#base-backup-failed) |
| Restore-verify drill failed | [RUNBOOK.md#backup-restore-verification-failed](RUNBOOK.md#backup-restore-verification-failed) |
| PITR to recover from bad migration | [RUNBOOK.md#pitr-recovery](RUNBOOK.md#pitr-recovery) |
| Quarterly full PITR drill on staging | [RUNBOOK.md#quarterly-pitr-drill](RUNBOOK.md#quarterly-pitr-drill) |

---

## Environment Variables (Production)

Add to your secret manager / `.env.production` (see `.env.example` for local):

```env
# WAL-G / pgBackRest configuration
WALG_S3_PREFIX=s3://credence-backups
WALG_COMPRESSION_METHOD=lz4
WALG_ENCRYPTION_KEY=base64-encoded-256-bit-key  # from KMS
AWS_REGION=us-east-1

# PostgreSQL connection for backup tools
PGHOST=credence-db-primary.cluster-xyz.us-east-1.rds.amazonaws.com
PGPORT=5432
PGUSER=walg_backup
PGPASSWORD=***  # injected from secret manager
PGDATABASE=postgres
```

**Required IAM policy** (least privilege for backup writer role):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:ListBucket",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::credence-backups",
        "arn:aws:s3:::credence-backups/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "arn:aws:kms:us-east-1:123456789:key/abcd-efgh-ijkl"
    }
  ]
}
```

---

## Local Development (No WAL Archiving)

Local `docker-compose.yml` uses a plain PostgreSQL container **without** WAL archiving. The weekly drill runs against a *live dump* (`pg_dump` → `pg_restore`) in an isolated schema. This is sufficient for verifying the verification logic itself.

To simulate a full PITR locally, use `pg_basebackup` + `restore_command` pointing to a local WAL archive directory — see PostgreSQL docs for "Continuous Archiving in Standalone Mode".

---

## Related Documents

- [docs/backup-restore.md](backup-restore.md) — Weekly restore-verify drill implementation details
- [docs/RUNBOOK.md](RUNBOOK.md) — Operational runbooks for backup/restore incidents
- [docs/monitoring.md](monitoring.md) — Prometheus alerts for WAL archiving, replica lag, backup verification
- [docs/architecture.md](architecture.md) — System architecture including DB topology
- [PRODUCTION.md](../PRODUCTION.md) — Production deployment configuration
- [.env.example](../.env.example) — Environment variable reference

---

## Changelog

| Date | Change | Author |
|------|--------|--------|
| 2025-07-23 | Initial version: WAL + PITR posture, retention, restore procedures, verification cadence | @victoromorogbe |