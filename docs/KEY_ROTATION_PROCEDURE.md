# Key Rotation Procedure

**Target Audience:** Platform operators, security engineers, and contributors managing JWT signing keys and evidence encryption keys.

This document describes the key rotation cadence, grace window, and verification checks for the Credence Backend's cryptographic keys. It covers both the JWT signing key lifecycle (`KeyManager`) and the evidence encryption key lifecycle (`KekManager`).

---

## 1. Overview

Credence Backend manages two independent key categories:

| Key Type | Manager Class | Purpose | Algorithm |
|---|---|---|---|
| JWT Signing Keys | `KeyManager` | Issue and verify JWT authentication tokens | RSA PS256 |
| Evidence Encryption Keys (KEK) | `KekManager` | Envelope-encrypt evidence records at rest | AES-256 |

Each follows a distinct rotation procedure. This document covers both.

---

## 2. JWT Signing Key Rotation (`KeyManager`)

### 2.1 Key Lifecycle

JWT signing keys progress through three states:

```
active ──rotate()──▶ retired ──pruneExpiredKeys()──▶ (deleted)
```

- **Active:** The current signing key. All new JWTs are signed with this key.
- **Retired:** A recently rotated key kept alive for grace-period verification. Tokens signed with this key remain valid during the grace window.
- **Deleted:** The key has been hard-pruned and can no longer verify any token.

### 2.2 Grace Window

The grace window is the period after rotation during which the retired key can still verify tokens. It is configured by two environment variables:

| Variable | Default | Description |
|---|---|---|
| `KEY_GRACE_PERIOD_SECONDS` | `3600` (1 hour) | Time a retired key remains valid for JWT verification |
| `KEY_CLOCK_SKEW_SECONDS` | `300` (5 minutes) | Clock tolerance added to the grace window to account for issuer/verifier clock drift |

**Total grace window = `KEY_GRACE_PERIOD_SECONDS + KEY_CLOCK_SKEW_SECONDS`**

With defaults: a retired key remains valid for **3600 + 300 = 3900 seconds (65 minutes)** after rotation.

### 2.3 Rotation Procedure

Rotation is performed by calling `keyManager.rotate()`:

1. The current active key is marked as `retired` with `retiredAt` set to the current timestamp.
2. A new RSA-2048 key pair is generated and set as the active key.
3. Expired retired keys (past the grace + skew window) are pruned.
4. The JWKS cache is invalidated so `/.well-known/jwks.json` reflects the new key set.
5. Audit events `KEY_RETIRED` and `KEY_ROTATED` are emitted.

**Returns:** `{ newKid, retiredKid }` — the identifiers of the new and retired keys.

### 2.4 Verification Checks During Rotation

| Check | When | What happens on failure |
|---|---|---|
| `isInitialized()` guard | `rotate()` called before `initialize()` | Throws `"KeyManager not initialized"` |
| JWKS cache invalidation | After every rotation | Ensures `/.well-known/jwks.json` returns the updated key set |
| Grace window enforcement | `verifyToken()` | Tokens signed with a key outside the grace window are rejected with `"Unknown or expired signing key"` |
| `kid` lookup | `verifyToken()` | Extracts `kid` from JWT protected header, looks up in active + retired keys |
| Clock tolerance | `jwtVerify()` | `clockTolerance` set to `clockSkewSeconds` to tolerate slightly-fast/slow issuer clocks |

### 2.5 Token Verification Flow

```
1. Decode JWT protected header → extract kid
2. getAllVerificationKeys() → active key + retired keys within grace window
3. Find key by kid → reject if not found ("Unknown or expired signing key")
4. jwtVerify(token, publicKey, { clockTolerance: clockSkewSeconds })
5. Return payload or reject with signature/expiration error
```

### 2.6 JWKS Endpoint Behavior

The `getPublicJwks()` method returns the `/.well-known/jwks.json` response:

- Includes the active key and all retired keys within the grace + skew window.
- Private key material (`d`, `p`, `q`, `dp`, `dq`, `qi`) is **never** included.
- Response is cached for 10 minutes (`JWKS_CACHE_TTL_MS`).
- Cache is invalidated on rotation, pruning, or initialization.

---

## 3. Evidence Encryption Key Rotation (`KekManager`)

### 3.1 Key Lifecycle

KEK versions progress through four states:

```
registered (retired) ──dual-control approval──▶ active ──superseded──▶ retired ──zeroizeRetired()──▶ zeroized
```

- **Registered:** A new KEK version awaiting dual-control approval.
- **Active:** The current KEK. All new evidence records are encrypted with this version.
- **Retired:** A superseded KEK. Retained for decrypting legacy records during re-encryption.
- **Zeroized:** Key material overwritten with zeros. Records encrypted under this version are irrecoverable.

### 3.2 Dual-Control Requirement

KEK activation requires **two distinct approvals** (`KekManager.REQUIRED_APPROVALS = 2`). This enforces dual-control: no single operator can unilaterally activate a new encryption key.

### 3.3 Rotation Procedure

The full rotation procedure is documented in detail in [kms-rotation-runbook.md](kms-rotation-runbook.md). Summary:

1. **Register** a new KEK version (32-byte AES-256 key material)
2. **Approve** — two distinct operators must call `approveActivation(version, approver)`
3. **Activate** — `activateVersion(version)` retires the previous version
4. **Re-encrypt** existing records from old version to new version
5. **Zeroize** retired key material via `zeroizeRetired()`

### 3.4 Verification Checks During Rotation

| Check | When | What happens on failure |
|---|---|---|
| Key material length | `registerVersion()` | Rejects if not exactly 32 bytes |
| Duplicate approver | `approveActivation()` | Throws if the same approver records approval twice |
| Approval threshold | `activateVersion()` | Throws if fewer than 2 distinct approvals recorded |
| Version existence | `activateVersion()` | Throws if the version was never registered |
| Already active | `activateVersion()` | Throws if the version is already active |

### 3.5 Overlap-Window Decryptability

After activation, the old KEK version remains in memory with its key material intact. This ensures:

- Records encrypted under the old version can still be decrypted during re-encryption.
- No "invalid window" exists where data is undecryptable.
- Old key material is only zeroized after explicit confirmation that re-encryption is complete.

---

## 4. Audit Trail

### JWT Signing Keys

Every key state transition emits a `KeyAuditEvent`:

| Event | When |
|---|---|
| `KEY_CREATED` | `initialize()` generates or imports the initial active key |
| `KEY_ROTATED` | `rotate()` activates a new key (includes `previousActiveKid`) |
| `KEY_RETIRED` | `rotate()` retires the previous active key |
| `KEY_PRUNED` | `pruneExpiredKeys()` removes a key past its grace window |

Access the audit log via `keyManager.getAuditLog()`.

### Evidence Encryption Keys

Every KEK lifecycle transition emits a `KekAuditEvent`:

| Event | When |
|---|---|
| `KEK_REGISTERED` | A new version is registered |
| `KEK_ACTIVATED` | A version is promoted to active (includes `previousVersion`) |
| `KEK_RETIRED` | The previous active version is superseded |
| `KEK_ZEROIZED` | Retired key material is overwritten with zeros |

Access the audit log via `kekManager.getAuditLog()`.

---

## 5. Operational Checklist

### JWT Signing Key Rotation

- [ ] Call `keyManager.rotate()` during a maintenance window or via the `key-rotation-worker` service account
- [ ] Verify audit log contains `KEY_RETIRED` and `KEY_ROTATED` events
- [ ] Confirm `/.well-known/jwks.json` returns two entries (active + retired) immediately after rotation
- [ ] Wait for the full grace window (default: 65 minutes) before considering the old key fully expired
- [ ] Run `keyManager.pruneExpiredKeys()` to hard-delete expired keys (or let the rotation cycle handle it)
- [ ] Verify tokens signed with the old key are rejected after pruning

### Evidence Encryption Key Rotation

- [ ] Follow the full runbook: [kms-rotation-runbook.md](kms-rotation-runbook.md)
- [ ] Ensure two distinct operators complete dual-control approval
- [ ] Verify re-encryption completes with `failed=0`
- [ ] Confirm `KEK_ZEROIZED` event in audit log after zeroization
- [ ] Run `npm test -- keyRotation` to verify post-rotation correctness

---

## 6. Configuration Reference

| Variable | Default | Applies To | Description |
|---|---|---|---|
| `KEY_GRACE_PERIOD_SECONDS` | `3600` | `KeyManager` | Seconds a retired JWT signing key remains valid |
| `KEY_CLOCK_SKEW_SECONDS` | `300` | `KeyManager` | Clock tolerance added to the grace window |
| `KEY_PRIVATE_PEM` | — | `KeyManager` | Optional PEM key to import as the initial signing key (ensures tokens survive restarts) |
| `KEY_INITIAL_KID` | — | `KeyManager` | Optional stable `kid` for the PEM-loaded key |
| `EVIDENCE_ENCRYPTION_KEY` | — | `KekManager` | Bootstrap KEK key material (32 bytes) |

---

## 7. Related Documents

| Document | Covers |
|---|---|
| [kms-rotation-runbook.md](kms-rotation-runbook.md) | Step-by-step KEK rotation runbook with dual-control approval |
| [SECRETS.md](SECRETS.md) | Secret types, rotation cadence, and blast radius for all credential types |
| [SERVICE_ACCOUNTS.md](SERVICE_ACCOUNTS.md) | Service account permissions including the `key-rotation-worker` |
| [JWT_CLAIMS.md](JWT_CLAIMS.md) | JWT claims, headers, and consumer middleware |
| `src/services/keyManager/index.ts` | `KeyManager` and `KekManager` implementation |
| `src/services/keyManager/types.ts` | Type definitions for managed keys, KEK versions, and audit events |
| `src/services/keyManager/keyManager.test.ts` | KeyManager unit tests including rotation boundary and pruning tests |
| `src/services/keyManager/kekManager.test.ts` | KekManager unit tests including dual-control and overlap-window tests |
