# Secret-Rotation Posture

This document describes the secret management and rotation policies for the Credence economic trust protocol backend.

---

## Target Audience
This document is written for **Contributors** (developers, security reviewers, and maintainers) of the Credence Backend. It outlines how credentials, signing keys, and encryption secrets are stored, how they are rotated programmatically or operationally, and the security boundaries (blast radius) of each secret type.

---

## Overview of Secrets

The platform manages four main types of credentials and secrets:

1. **Evidence Key Encryption Keys (KEK)** — AES-256 keys protecting dispute and slashing evidence.
2. **JWT Signing Keys** — RSA key pairs used to issue and verify user authentication tokens.
3. **Integration API Keys** — Hashed credentials issued to users/organizations to query public and admin APIs.
4. **Webhook Signing Secrets** — Secrets used to sign outbound payloads sent to event subscribers.

---

## 1. Evidence Key Encryption Keys (KEK)

### Purpose & Architecture
All sensitive dispute/slashing evidence submitted by users is encrypted at rest using envelope encryption:
- Each evidence record is encrypted with a unique, randomly generated 32-byte **Data Encryption Key (DEK)** via AES-256-GCM.
- The DEK is then encrypted ("wrapped") using the active **Key Encryption Key (KEK)** and stored alongside the record.
- In-memory key versioning is handled by [KekManager](file:///c:/Users/DELL/Documents/GitHub/Credence-Backend/src/services/keyManager/index.ts#L325-L486).

### Where They Live
- **Local Dev / Testing:** Defined via the `EVIDENCE_ENCRYPTION_KEY` environment variable in [`.env`](file:///c:/Users/DELL/Documents/GitHub/Credence-Backend/.env.example).
- **Production:** Injected dynamically into the container environment or operations tooling from a secure secrets vault (e.g., HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager) under versioned identifiers (e.g., `EVIDENCE_ENCRYPTION_KEY_V1`, `EVIDENCE_ENCRYPTION_KEY_V2`).

### Rotation Cadence
- **Manual / On-Demand:** Triggered manually by the Platform Security / Operations team periodically (e.g., annually) or immediately upon suspected credential exposure.

### Blast Radius & Mitigation
- **Exposed KEK:** If a specific KEK version is compromised, only evidence records encrypted under that version's identifier are exposed. Other versions remain secure.
- **Migration Failure / Early Zeroization:** If a retired KEK is zeroized before historical records have been re-encrypted to the new version, those older evidence records become permanently unreadable.
- **Mitigation:** The re-encryption worker performs migration online and is idempotent. Always ensure re-encryption completes and backups are verified before zeroizing old keys in the vault.

### Concrete Rotation Example
KEK rotation uses a programmatically enforced **dual-control** (two-approver) process via [scripts/rotate-kms-key.ts](file:///c:/Users/DELL/Documents/GitHub/Credence-Backend/scripts/rotate-kms-key.ts):

1. **Register a new KEK version:**
   ```bash
   EVIDENCE_ENCRYPTION_KEY="current-32-byte-active-key-here" \
     npx tsx scripts/rotate-kms-key.ts register
   ```
   *Output:* Generates a new KEK, prints its hex material, and returns a new version number (e.g., `v2`).

2. **Dual-Control Approval (Two different operators must run this):**
   ```bash
   # Approver 1
   EVIDENCE_ENCRYPTION_KEY="current-32-byte-active-key-here" \
     npx tsx scripts/rotate-kms-key.ts approve --version 2 --approver alice@example.com

   # Approver 2
   EVIDENCE_ENCRYPTION_KEY="current-32-byte-active-key-here" \
     npx tsx scripts/rotate-kms-key.ts approve --version 2 --approver bob@example.com
   ```

3. **Activate the new KEK (Retires the old KEK, uses new KEK for new uploads):**
   ```bash
   EVIDENCE_ENCRYPTION_KEY="current-32-byte-active-key-here" \
     npx tsx scripts/rotate-kms-key.ts activate --version 2
   ```

4. **Re-encrypt existing records from version 1 to version 2:**
   ```bash
   # Dry-run first to preview changes
   EVIDENCE_ENCRYPTION_KEY="current-32-byte-active-key-here" \
     npx tsx scripts/rotate-kms-key.ts rotate --dry-run

   # Perform batch re-encryption (updates DEKs to be wrapped under KEK v2)
   EVIDENCE_ENCRYPTION_KEY="current-32-byte-active-key-here" \
     npx tsx scripts/rotate-kms-key.ts rotate --batch-size 100
   ```

5. **Verify status & Zeroize retired key material:**
   Once re-encryption is completed, the CLI automatically zeroizes retired KEK material from memory. Ensure the old key is deleted from the secrets vault.
   ```bash
   EVIDENCE_ENCRYPTION_KEY="new-v2-32-byte-active-key-here" \
     npx tsx scripts/rotate-kms-key.ts status
   ```

See [docs/kms-rotation-runbook.md](file:///c:/Users/DELL/Documents/GitHub/Credence-Backend/docs/kms-rotation-runbook.md) for step-by-step operational details.

---

## 2. JWT Signing Keys

### Purpose & Architecture
Used to sign user authentication tokens (using the `PS256` algorithm). In-memory management is handled by [KeyManager](file:///c:/Users/DELL/Documents/GitHub/Credence-Backend/src/services/keyManager/index.ts#L34-L298).

### Where They Live
- **Startup Config:** Can be pre-loaded as a stable PKCS#8 PEM-encoded RSA private key via `KEY_PRIVATE_PEM` (with optional `KEY_INITIAL_KID`).
- **Dynamic Generation:** If `KEY_PRIVATE_PEM` is not set, a new RSA key pair is generated dynamically in-memory on server startup.
- **JWK Set Endpoint:** Public keys are served at `/.well-known/jwks.json` for validation by downstream verification clients.

### Rotation Cadence
- **Automated:** The background task rotates keys in-memory every `KEY_ROTATION_INTERVAL_SECONDS` (default: `86400` seconds / 24 hours).

### Blast Radius & Mitigation
- **Key Compromise:** If a JWT signing key is compromised, an attacker can forge JWTs.
- **Grace Period / User Disruption:** When keys rotate, the old key remains in a `retired` state and continues verifying existing tokens for `KEY_GRACE_PERIOD_SECONDS` (default: `3600` seconds / 1 hour) plus `KEY_CLOCK_SKEW_SECONDS` (default: `300` seconds / 5 minutes). Once this window expires, the key is hard-pruned, and any user whose token was signed by the pruned key is logged out.
- **Mitigation:** The 24-hour rotation limit restricts the window of usability for compromised keys. The 1-hour grace period ensures active users do not experience session termination during key rollover.

### Configurable Parameters (.env)
```ini
# Cadence to rotate the active signing key (24h)
KEY_ROTATION_INTERVAL_SECONDS=86400

# How long a retired key can still verify existing JWTs (1h)
KEY_GRACE_PERIOD_SECONDS=3600

# Clock skew tolerance added to the grace window (5 min)
KEY_CLOCK_SKEW_SECONDS=300

# Optional: Initial PKCS8 private key PEM to keep keys stable across restarts
# KEY_PRIVATE_PEM="-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----"
# KEY_INITIAL_KID="my-key-v1"
```

---

## 3. Integration API Keys

### Purpose & Architecture
Issued to users and organizations to query public data and perform admin actions. Handled by [ApiKeyRotationService](file:///c:/Users/DELL/Documents/GitHub/Credence-Backend/src/services/apiKeyRotationService.ts).

### Where They Live
- Hashed (SHA-256) inside the database. The raw key is only shown once to the user upon creation.
- A prefix (e.g., `cre_`) is kept plain-text in the database for identification and lookup.

### Rotation Cadence
- **Manual / On-Demand:** Triggered by the key owner or an administrator via the management API.

### Blast Radius & Mitigation
- **Key Compromise:** An attacker gains access to endpoints within the key's assigned scope.
- **Safe Invalidation (No Grace Period):** Rotation is immediate. The old key is revoked instantly and cannot be used.
- **Mitigation:** Invalidation is atomic. The new key is returned immediately. Downstream integrations must be updated to use the new key without delay to minimize downtime.

### Concrete Rotation Example
API keys are rotated by issuing a `POST` request to the rotation endpoint:

```http
POST /api/integrations/keys/key_01h7x2z3a4b5c6d7e8f9g0h1j2/rotate
Authorization: Bearer <user-jwt-token>
Content-Type: application/json
```

*Response (200 OK):*
```json
{
  "success": true,
  "message": "API key rotated. Store the new key securely — it will not be shown again.",
  "data": {
    "id": "key_01h7x2z3a4b5c6d7e8f9g0h1j2",
    "key": "cre_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "prefix": "cre_live_",
    "scope": "read",
    "tier": "pro",
    "active": true
  }
}
```

---

## 4. Webhook Signing Secrets

### Purpose & Architecture
Used to sign payloads sent to external subscribers via `X-Webhook-Signature` HMAC headers so receiving servers can verify the authenticity of the webhook event. Handled by [WebhookRotationService](../src/services/webhooks/rotationService.ts). For full operator procedures, see **[Webhook Signature Operator Guide](WEBHOOK_SIGNING.md)**.

### Where They Live
- Stored plain-text (or encrypted) in the database in the webhooks subscription table.

### Rotation Cadence
- **Manual / On-Demand:** Triggered by subscribers or administrators when rotating webhook configurations.

### Blast Radius & Mitigation
- **Secret Compromise:** An attacker can forge webhook events to the subscriber's endpoint.
- **Verification Grace Period:** To prevent delivery disruption, the old secret is kept as `previousSecret` and remains valid for signing/verification for **24 hours** (`PREVIOUS_SECRET_TTL_MS`).
- **Mitigation:** During the 24-hour grace period, webhook dispatches are signed using the new secret, but the system logs metadata allowing validation tools to transition gracefully. Subscribers must update their signature verification code within 24 hours.

### Concrete Rotation Example
Webhook secrets are rotated by administrators or owners via the rotation endpoint:

```http
POST /api/webhooks/wh_9876543210abcdef/rotate-secret
Authorization: Bearer <user-jwt-token>
Content-Type: application/json
```

*Response (200 OK):*
```json
{
  "success": true,
  "data": {
    "webhookId": "wh_9876543210abcdef",
    "newSecret": "d9f8e7d6c5b4a392817263544536271809a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4",
    "rotatedAt": "2026-07-24T00:30:00.000Z",
    "previousSecretExpiresAt": "2026-07-25T00:30:00.000Z"
  }
}
```
