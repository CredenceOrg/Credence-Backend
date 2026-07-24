# Security Architecture

## API Key Scope Model

### Granular Scopes (Least Privilege)

Every API key is issued with an explicit set of **scopes** that determine which endpoints it may call. The middleware enforces a **deny-by-default** policy: if the key's granted scopes do not cover the required scope, the request is rejected with `403 Forbidden` before reaching any handler.

| Scope                | Grants access to                                                   |
|----------------------|--------------------------------------------------------------------|
| `trust:read`         | Trust scores and bond read endpoints                               |
| `attestations:read`  | Attestation list and count endpoints                               |
| `attestations:write` | Create and revoke attestations                                     |
| `payouts:write`      | Payout / settlement creation                                       |
| `reports:generate`   | Report job creation and status polling                             |
| `exports:read`       | Report artifact downloads and audit-log exports                    |
| `webhooks:admin`     | Webhook secret rotation and revocation                             |
| `admin:read`         | Admin read operations (users, audit logs, failed events)           |
| `admin:write`        | Admin write operations (role assignment, key revocation, impersonation, event replay) |

Legacy `public` and `enterprise` values are still accepted and automatically expanded to their respective scope sets (see `docs/api-keys.md`).

### Scope Enforcement Implementation

`src/middleware/auth.ts` exports:

- **`ApiScope`** — enum of all valid scope strings.
- **`SCOPE_SETS`** — maps legacy tier names to their expanded `Set<ApiScope>`.
- **`scopeSatisfies(grantedScopes, requiredScope)`** — pure function; returns `true` when the granted set covers the required scope (including legacy expansion).
- **`requireApiKey(requiredScope)`** — Express middleware factory. Reads the key from `X-API-Key` or `Authorization: Bearer`, validates it, checks scope, and attaches `{ key, scopes, scope }` to `req.apiKey`.

### Scope Assignment at Key Creation

When issuing a key via `generateApiKey` / `InMemoryApiKeyRepository.create`, pass an explicit `scopes` array:

```typescript
repo.create('owner-id', 'trust:read', 'free', ['trust:read', 'attestations:read'])
```

The `scopes` array is stored on `StoredApiKey` and preserved through key rotation.

### Security Properties

- **Deny-by-default**: missing or insufficient scope → `403` before handler execution.
- **No scope escalation**: a key can only be rotated to the same or narrower scope set.
- **Audit trail**: every `403` response includes `requiredScope` and `grantedScopes` for debugging without leaking key material.
- **Backward compatibility**: existing `enterprise` keys continue to work and satisfy all granular scopes.

---

## Encrypted Evidence Storage

Dispute and slash evidence submitted to the platform often contain sensitive user data. To ensure privacy, security, and integrity, all evidence is encrypted at rest before being saved to the database or object storage.

### Encryption Standard
- **Algorithm**: AES-256-GCM (Galois/Counter Mode).
- **Key Management**: Managed via environment variables (`EVIDENCE_ENCRYPTION_KEY`). It must be exactly 32 bytes.
- **Integrity Validation**: GCM provides an authentication tag (`authTag`). During decryption, this tag ensures the data has not been tampered with or corrupted in the storage layer.

### Access Control (RBAC)
Access to decrypted evidence is strictly limited using Role-Based Access Control.
- **USER**: Denied access to view encrypted evidence blobs.
- **ARBITRATOR**: Granted access to retrieve and decrypt evidence for reviewing active disputes.
- **GOVERNANCE**: Granted access to retrieve and decrypt evidence for auditing, slashing events, and platform management.

### Evidence Audit Trail

All sensitive evidence actions are written to the immutable audit stream:

### Crypto-Shred for Evidence at End-of-Retention

At end-of-retention (configured per entity via `RETENTION_TTL_EVIDENCE_DAYS`), evidence records are cryptographically shredded to ensure data is permanently unrecoverable.

**Per-row DEK (Data Encryption Key):**
- Each evidence record generates a random 32-byte AES-256 DEK at upload time.
- The DEK encrypts the evidence payload (AES-256-GCM).
- The DEK is itself encrypted ("wrapped") with the tenant-level KEK (AES-256-GCM).
- Both the ciphertext and the wrapped DEK are stored alongside the record.

**Shred process:**
1. The `DataRetentionJob` identifies expired evidence records (based on `created_at` + TTL).
2. Records with `legal_hold = true` are skipped.
3. For each eligible record:
   a. A signed proof-of-erasure JWT is created: `{ evidence_id, erased_at, nonce, tenant_id, actor_id }` — signed with the keyManager RSA key (PS256).
   b. The wrapped DEK, IV, auth tag, and encrypted blob are all zeroized.
   c. `shredded_at` is set to the current timestamp.
   d. An `EVIDENCE_SHREDDED` audit log entry is written containing the signed proof JWT.
4. The metadata row is then soft-deleted (`deleted_at` set, `encrypted_blob` cleared).

**Proof-of-erasure:**
- Each shred produces a JWT signed by the keyManager (HSM-backed in production).
- The JWT includes a random UUID nonce, preventing replay attacks.
- Proofs can be retrieved via `GET /v1/admin/erasure-proof/:id` for regulator response.
- The audit log's hash chain provides additional tamper evidence.

**Legal hold override:**
- Evidence flagged with `legal_hold = true` is immune to retention-based crypto-shred.
- The `setLegalHold(evidenceId, boolean)` method on `EvidenceStorageService` controls this flag.

**Crash recovery:**
- If a crash occurs during shred, the next retention run checks `shredded_at` on each record.
- Already-shredded records are idempotently skipped (a new proof is still generated).

## API Key Handling (Integrations)

- **Hashed storage**: API keys are never stored in plain text. Only a SHA-256 hash of the raw key is persisted.
- **Shown once**: The raw key is returned exactly once at creation/rotation and must be stored securely by the integrator.
- **Timing-safe validation**: Key comparisons are performed via constant-time hash checks to avoid timing attacks; raw keys are not logged.
- **Rotation & revocation**: Keys can be rotated or revoked. Rotation issues a new raw key and revokes the previous one; revocation immediately prevents further access.
- **Test isolation**: Tests should generate keys via the API/key-service helpers and must reset the in-memory store between runs.

Never commit raw API keys, test fixtures with live keys, or example bearer tokens to source control or documentation. Use placeholder values or generated keys in tests and CI only.

- `EVIDENCE_UPLOADED` when evidence is stored
- `EVIDENCE_ACCESSED` when evidence is decrypted and returned

Each event includes actor metadata, action name, timestamp, and evidence resource id, enabling compliance queries by actor, resource, and time range.

## Rate Limiting

### Architecture

Rate limiting is enforced in `src/middleware/rateLimit.ts` using Redis fixed-window counters. Two independent counters are maintained per request:

1. **Tenant bucket** — keyed by `ratelimit:<namespace>:tenant:<ownerId>:<windowStart>`. Enforces the tier ceiling shared across all API keys belonging to the same owner.
2. **Per-key bucket** — keyed by `ratelimit:<namespace>:key:<keyId>:<windowStart>`. Enforces the same tier ceiling scoped to a single API key, preventing one noisy key from exhausting the shared tenant budget.

A request is rejected (HTTP 429) when **either** counter exceeds the limit for the request's subscription tier.

### Fail-closed mode (production default)

When Redis is unavailable the middleware behaviour is controlled by `RATE_LIMIT_FAIL_OPEN`:

- **`false` (default in `NODE_ENV=production`)** — the middleware returns `503 Service Unavailable`. This is the secure default: a Redis outage cannot be exploited to bypass rate limits.
- **`true` (default in `development` / `test`)** — the middleware passes the request through. Useful for local development where Redis may not always be running.

The catch-block fallback in `src/app.ts` also derives `failOpen` from `NODE_ENV`, so a `validateConfig` failure at startup cannot silently disable limits in production.

### Prometheus metric

`rate_limit_rejected_total` (counter) is incremented on every rejected request with labels:

| Label | Values |
|-------|--------|
| `tier` | `free`, `pro`, `enterprise` |
| `key_id` | API key id, or `none` |
| `reason` | `tenant_limit`, `key_limit`, `redis_unavailable` |

`rate_limit_hits_total` (counter) is emitted for each request that exceeds either the tenant or per-key quota. Labels:

| Label | Values |
|-------|--------|
| `tenant` | Resolved tenant identifier, or `unknown` for unauthenticated requests |
| `tier` | `free`, `pro`, `enterprise` |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Enable / disable rate limiting |
| `RATE_LIMIT_WINDOW_SEC` | `60` | Fixed-window size in seconds |
| `RATE_LIMIT_MAX_FREE` | `100` | Max requests per window for free tier |
| `RATE_LIMIT_MAX_PRO` | `1000` | Max requests per window for pro tier |
| `RATE_LIMIT_MAX_ENTERPRISE` | `10000` | Max requests per window for enterprise tier |
| `RATE_LIMIT_FAIL_OPEN` | `false` in prod, `true` in dev/test | Fail-open (`true`) or fail-closed (`false`) on Redis error |

### Security considerations

- **Misconfiguration cannot disable limits in production.** The `RATE_LIMIT_FAIL_OPEN` default is `false` when `NODE_ENV=production`, and the startup fallback in `src/app.ts` mirrors this.
- **Key identifiers are never stored in plain text.** When no authenticated record is present, the tenant id is derived from a truncated SHA-256 hash of the API key or Bearer token.
- **Per-key isolation** ensures that a compromised or misbehaving key cannot exhaust the rate budget of other keys belonging to the same tenant.

## Secret Scanning Response Playbook

- **Detect**: Gitleaks runs in CI weekly and as a pre‑commit hook. If a secret is found, the CI job fails and the pre‑commit aborts.
- **Alert**: The CI workflow uploads a `gitleaks-report.json` artifact. Review the findings in the GitHub Actions UI.
- **Triage**:
  - Verify the secret is indeed exposed and not an allow‑listed fixture.
  - Determine the severity (e.g., exposed private key vs. dummy token).
- **Remediation**:
  - Revoke the leaked credential immediately (rotate API keys, reset passwords, invalidate tokens).
  - Remove the secret from the repository history using `git filter-repo` or `bfg` if necessary, then force‑push.
  - Update the `.gitleaks.toml` allowlist if the secret is a legitimate test fixture.
- **Post‑mortem**:
  - Document the incident in the security incident log.
  - Add unit tests to ensure similar patterns are caught by the allowlist.
  - Review CI configuration to ensure no secrets leak in future releases.

For more details see the [Gitleaks documentation](https://github.com/gitleaks/gitleaks).

---

## Dependency Vulnerability Scanning & SLAs

To ensure a secure supply chain, the platform automatically scans third-party dependencies for known Common Vulnerabilities and Exposures (CVEs) and enforces strict response time Service Level Agreements (SLAs).

### Scanning Architecture

Vulnerability scanning is orchestrated in `.github/workflows/vuln-scan.yml` and is triggered on every Pull Request targeting `main`/`develop` as well as on a **nightly cron schedule** (at 00:00 UTC).

The pipeline runs two complementary scanning engines:
1. **`npm audit` (Production-only)**: Focused specifically on production runtime dependencies (`npm audit --omit=dev`), ensuring that development tools (like local compilers or test libraries) do not block release workflows unless they present runtime risk.
2. **Trivy SBOM Scan (`trivy fs .`)**: Conducts a complete filesystem-level static security scan across all packages, lockfiles, and configuration declarations.

A custom-built, fully unit-tested severity gate engine (`scripts/security-gate.ts`) parses the output of both tools. If any vulnerability is found matching or exceeding the configured severity threshold (default is **HIGH**), the script prints the offending advisory details and exits with `1`, **failing the build**.

### SBOM Generation & Validation (every merge)

`.github/workflows/sbom.yml` runs on every push and pull request to `main` and `develop`. It generates a CycloneDX SBOM (`npm run sbom:generate`) and then validates it (`npm run sbom:check`), uploading the result as a build artifact.

Validation is enforced by `scripts/sbom-validate.ts`, which checks the document against a minimal CycloneDX schema (format marker, spec version, non-empty component inventory) using Zod. It returns a typed discriminated-union result — `SCHEMA_MISMATCH`, `EMPTY_COMPONENTS`, or `INVALID_JSON` — and the CLI exits with `1`, **failing the build**, rather than panicking or emitting a generic error.

**Threat mitigated:** without a generated-and-validated SBOM gate on every merge, a compromised or accidentally-introduced (transitive) dependency can enter the production dependency graph with no machine-readable inventory and no build gate that fails closed. The gate guarantees every merged commit ships a verifiable component inventory.

Developers can run the same checks locally:

```bash
npm run sbom:generate
npm run sbom:check
```

### Pull Request SBOM Component Diff

`.github/workflows/sbom-diff.yml` runs on pull requests to `main` and `develop`. The workflow checks out both the pull request head and base commit, generates CycloneDX SBOM files for each dependency graph, and runs `scripts/sbom-component-diff.js` to compare their component lists.

The workflow posts or updates a single pull request comment named **SBOM component changes**. The comment shows the count and names of components added by the pull request and components removed relative to the base branch, giving operators and downstream consumers a quick supply-chain review surface without downloading SBOM artifacts.

Developers can run the same local component-diff smoke check with:

```bash
npm run sbom:generate
npm run sbom:diff
```

### Response SLA Matrix

Vulnerabilities discovered in production dependencies must be triaged, patched, and resolved according to the following strict SLA timeline:

| Severity Level | Definition | SLA for Resolution / Mitigation | Enforced CI Gate |
| :--- | :--- | :--- | :--- |
| **SEV1 (Critical & High)** | CVEs classified as High or Critical (CVSS $\ge 7.0$). Poses immediate risk of exposure, data leak, or compromise. | **Within 24 Hours** from detection. | Yes (Blocks build immediately) |
| **SEV2 (Medium / Moderate)** | CVEs classified as Medium or Moderate (CVSS $4.0 - 6.9$). Lower exploitability or limited impact. | **Within 7 Days** from detection. | Alerting / Policy Warning |
| **SEV3 (Low)** | CVEs classified as Low (CVSS $< 4.0$) or located in development-only dependencies. | Best effort (Targeted in next minor/patch release). | No |

### Auto-PR Grouping & Renovate Configuration

Dependency updates are automated using **Renovate** (`renovate.json`). Security patches and upgrades are automatically generated and grouped by ecosystem to prevent PR fatigue:
* **`npm-ecosystem-updates`**: Groups all JavaScript/TypeScript runtime and dev package updates.
* **`github-actions-updates`**: Groups GitHub Actions workflow updates.
* **`docker-ecosystem-updates`**: Groups base image updates for Dockerfiles and Compose configurations.

> [!IMPORTANT]
> **Manual Human Review Gate**: Renovate is strictly configured to **never auto-merge major version upgrades** (`automerge: false`). All major dependency upgrades require developer triage, comprehensive integration test suite passes, and peer approval to protect against breaking API changes and supply chain injection.

### Handling False Positives, Ignored CVEs & Overrides

When an upstream dependency contains a vulnerability that cannot be immediately patched (e.g., no patch version is available yet) or represents a confirmed false positive that is non-exploitable in our architecture:
1. Conduct an impact assessment with security owners.
2. If approved, add the package or specific CVE ID to the ignore allowlist in the pipeline:
   ```bash
   npx tsx scripts/security-gate.ts --file audit-report.json --threshold high --ignore-cve CVE-YYYY-XXXXX --ignore-pkg package-name
   ```
3. Document the bypass justification, the expiration date of the exception, and the signed security ticket reference in the commit message and PR description.

---

## CORS Origin Policy

### Approved Origin Configuration
In non-production environments (such as `development` or `test`), the wildcard origin (`*`) is allowed by default for convenience in local testing. 

In the production environment, the `CORS_ORIGIN` environment variable must be explicitly configured to one or more approved, fully-qualified domain names (FQDNs). Wildcard origins (`*`) are strictly blocked at the configuration level during startup validation to enforce security.

Example of an approved single-origin configuration in production:
```ini
CORS_ORIGIN=https://app.credence.io
```

Example of multiple allowed origins:
```ini
CORS_ORIGIN=https://app.credence.io,https://admin.credence.io
```

### Why Wildcard Origins are Prohibited in Production
Allowing wildcard origins (`*`) in a production environment introduces severe security risks:
1. **Cross-Origin Resource Sharing (CORS) Bypass**: The browser's same-origin policy is disabled for all websites. A malicious website visited by a user could send requests to the Credence API on behalf of that user.
2. **Credential Exposure Risk**: Wildcard CORS prevents the secure usage of HTTP credentials (cookies, client certificates, or authorization headers) in cross-origin requests. Restricting origins enforces a strict trust boundary.
3. **Compliance Requirements**: Regulatory frameworks and security standards (e.g., SOC2, ISO 27001) prohibit wildcard resource access for authenticated APIs to prevent unauthorized data exfiltration.

### Deployment Guidance
When deploying to production, operators must configure allowed origins:
1. Identify all trusted client applications that need to communicate directly with the API.
2. Set the `CORS_ORIGIN` environment variable to those trusted origins in the production environment (e.g., Kubernetes ConfigMaps, AWS ECS task definitions, or environment managers).
3. If `CORS_ORIGIN` is not set, or is explicitly set to `*`, the startup validation will fail and the application will refuse to boot, preventing insecure deployment configurations.
4. When validation fails, the application prints a typed, actionable error message to standard error before exiting:
   ```
   ❌ Environment validation failed:
     - CORS_ORIGIN: Wildcard CORS origin (*) is prohibited in production environment
   ```
