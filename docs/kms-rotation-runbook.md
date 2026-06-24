# KMS Rotation Runbook

**Service:** Credence Backend — Evidence Storage  
**Owner:** Platform Security  
**Last updated:** 2026-05-31  
**Estimated time:** 30–60 minutes (excluding re-encryption, which scales with record count)

---

## Overview

Evidence records are encrypted at rest using AES-256-GCM with a versioned Key Encryption Key (KEK). This runbook covers:

1. Registering a new KEK version
2. Dual-control approval
3. Activating the new KEK
4. Running the automated re-encryption worker
5. Zeroizing retired key material
6. Rollback procedure

The `KekManager` class (`src/services/keyManager/index.ts`) maintains all KEK versions in memory. Each `EvidenceRecord` stores a `kek_version` field so the correct key is always used for decryption, regardless of which version was active at upload time.

---

## Prerequisites

- [ ] Access to the secrets manager / key vault holding `EVIDENCE_ENCRYPTION_KEY`
- [ ] Two authorized approvers available (dual-control requirement)
- [ ] Database backup completed and verified
- [ ] Maintenance window scheduled (re-encryption is online-safe but CPU-intensive)
- [ ] Monitoring dashboards open (error rate, latency)

---

## Step 1 — Generate a new KEK (≈5 min)

Generate a cryptographically random 32-byte key. **Never reuse an existing key.**

```bash
# Option A: use the CLI to generate and display a new key
EVIDENCE_ENCRYPTION_KEY="<current-32-byte-key>" \
  tsx scripts/rotate-kms-key.ts register

# Option B: supply your own key material (from HSM or secrets manager)
EVIDENCE_ENCRYPTION_KEY="<current-32-byte-key>" \
  tsx scripts/rotate-kms-key.ts register --key-hex <64-char-hex>
```

The CLI prints the new version number and the hex-encoded key material.

**Checklist:**
- [ ] Key material stored in secrets manager under `EVIDENCE_ENCRYPTION_KEY_V<n>`
- [ ] Key material **not** logged or committed to source control
- [ ] Version number noted: `v_______`

---

## Step 2 — Dual-control approval (≈10 min)

Two distinct approvers must record their approval before the new version can be activated.

```bash
# Approver 1
EVIDENCE_ENCRYPTION_KEY="<current>" \
  tsx scripts/rotate-kms-key.ts approve --version <n> --approver alice@example.com

# Approver 2 (different person)
EVIDENCE_ENCRYPTION_KEY="<current>" \
  tsx scripts/rotate-kms-key.ts approve --version <n> --approver bob@example.com
```

**Checklist:**
- [ ] Approval 1 recorded by: `_______________`
- [ ] Approval 2 recorded by: `_______________`
- [ ] Both approvers confirmed identity via out-of-band channel (Slack DM, phone)

---

## Step 3 — Activate the new KEK (≈2 min)

Activating the new version retires the previous one. All new uploads immediately use the new KEK. Existing records are still readable via their stored `kek_version`.

```bash
EVIDENCE_ENCRYPTION_KEY="<current>" \
  tsx scripts/rotate-kms-key.ts activate --version <n>
```

Verify:

```bash
EVIDENCE_ENCRYPTION_KEY="<current>" \
  tsx scripts/rotate-kms-key.ts status
```

Expected output: `v<n> [ACTIVE]`

**Checklist:**
- [ ] New version shows `[ACTIVE]` in status output
- [ ] Previous version shows `retired=<timestamp>`
- [ ] New uploads verified to use `kek_version: <n>` (smoke test)

---

## Step 4 — Re-encrypt existing records (≈variable)

The re-encryption worker pages through all evidence records and rewrites ciphertext from the old KEK to the new one. It is safe to run while the service is live:

- New uploads always use the active KEK (set in Step 3).
- The worker only touches records whose `kek_version` matches the old version.
- Re-running the worker is idempotent (already-migrated records are skipped).

### Dry run first

```bash
EVIDENCE_ENCRYPTION_KEY="<current>" \
  tsx scripts/rotate-kms-key.ts rotate --dry-run
```

### Run re-encryption

```bash
EVIDENCE_ENCRYPTION_KEY="<current>" \
  tsx scripts/rotate-kms-key.ts rotate --batch-size 100
```

Progress is printed to stdout. Send `SIGINT` (Ctrl+C) to pause; re-run to resume.

**Timing estimate:** ~1,000 records/minute on a single core. Adjust `--batch-size` to balance throughput vs. DB load.

**Checklist:**
- [ ] Dry run completed with no errors
- [ ] Re-encryption started: `_______________` (timestamp)
- [ ] Re-encryption completed: `_______________` (timestamp)
- [ ] `failed=0` in final output (or failed records investigated)
- [ ] Spot-check: retrieve 3–5 records and verify decryption succeeds

---

## Step 5 — Zeroize retired key material (≈1 min)

After re-encryption completes, the `rotate` command automatically zeroizes retired key material from memory. Confirm in the output:

```
Zeroized key material for retired versions: 1
```

Also remove the old key from the secrets manager:

- [ ] `EVIDENCE_ENCRYPTION_KEY_V<old>` deleted from secrets manager
- [ ] Old key material confirmed zeroized in audit log (`KEK_ZEROIZED` event)

---

## Step 6 — Post-rotation verification (≈5 min)

```bash
# Check audit log
EVIDENCE_ENCRYPTION_KEY="<new>" \
  tsx scripts/rotate-kms-key.ts status

# Run the test suite
npm test -- keyRotation
```

**Checklist:**
- [ ] Audit log shows: `KEK_REGISTERED`, `KEK_ACTIVATED`, `KEK_RETIRED`, `KEK_ZEROIZED`
- [ ] All tests pass
- [ ] No increase in error rate on `/api/evidence` endpoints
- [ ] Monitoring alerts clear

---

## Rollback Procedure

If re-encryption fails or the new KEK is compromised before zeroization:

1. **Do not zeroize** the old key material.
2. The old KEK version is still registered in `KekManager` and can decrypt any record with the old `kek_version`.
3. Re-activate the old version:

```bash
# Re-register the old key as a new version (it was retired, not deleted)
# The old key material is still in memory until zeroized
tsx scripts/rotate-kms-key.ts status   # confirm old version is still present
```

4. If the process restarted and old key material was lost, restore from the secrets manager backup and re-bootstrap.
5. Run the re-encryption worker in reverse (old → new → old) if needed.

**Rollback checklist:**
- [ ] Old key material confirmed available (not zeroized)
- [ ] Service restarted with old `EVIDENCE_ENCRYPTION_KEY`
- [ ] All records verified readable
- [ ] Incident ticket filed

---

## Security Notes

- **Dual-control**: Two distinct approvers are required to activate any new KEK. The `KekManager` enforces this programmatically.
- **Zeroization**: Key material is overwritten with zeros after retirement. Do not skip Step 5.
- **No key reuse**: Each rotation must use freshly generated key material.
- **Audit trail**: All KEK lifecycle events are recorded in `KekManager.getAuditLog()`. Persist this log to the audit store in production.
- **Concurrent writes**: Safe. New uploads use the active KEK; the worker only touches records on the old version.
- **Interrupted rotation**: Safe. Re-run the worker; already-migrated records are skipped.

---

## Reference

| File | Purpose |
|------|---------|
| `src/services/keyManager/index.ts` | `KekManager` class — KEK lifecycle |
| `src/services/keyManager/types.ts` | `KekVersion`, `KekAuditEvent` types |
| `src/services/evidence/storage.ts` | `EvidenceStorageService` — uses `kek_version` |
| `src/jobs/keyRotationWorker.ts` | `KeyRotationWorker` — batch re-encryption |
| `src/jobs/keyRotationWorker.test.ts` | Tests — edge cases and interruption |
| `scripts/rotate-kms-key.ts` | CLI — ops interface |
