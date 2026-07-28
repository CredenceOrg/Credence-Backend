# SBOM Strategy

## Purpose & Threat Model

A Software Bill of Materials (SBOM) is a machine-readable inventory of every component that ships in the production artifact. Without a generated-and-validated SBOM gate on every merge, the following threats are **not** mitigated:

| Threat                                   | Impact if SBOM gate missing                                                                                                                                                | Mitigation                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Compromised transitive dependency**    | A malicious or vulnerable transitive dependency enters the production dependency graph undetected, with no machine-readable inventory and no build gate that fails closed. | Every merged commit must carry a verifiable CycloneDX SBOM; the build fails if the SBOM is invalid, empty, or unparseable. |
| **Silent dependency drift**              | A developer's `npm install --save` adds a dependency that is never reviewed by the security pipeline.                                                                      | SBOM component diff on every PR surfaces added/removed components for human review.                                        |
| **Supply-chain incident response delay** | When a zero-day CVE is published, operators cannot quickly determine which deployments are affected.                                                                       | Published SBOMs enable fast `grep` / tool-assisted queries against the component inventory.                                |
| **Audit / compliance deficiency**        | External auditors or regulators cannot verify the composition of the production artifact.                                                                                  | A signed SBOM artifact is retained for every release.                                                                      |

**Defence-in-depth rationale:** Even though there is no public report of exploitation of this gap, the absence of a supply-chain inventory gate is the kind of finding a careful auditor would flag. Closing it before any external review establishes the security baseline proactively rather than reactively.

---

## Artifacts Covered

| Artifact                        | Format                       | Tool                                                                     | Scope                                                                                                    |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **npm production dependencies** | CycloneDX JSON (`sbom.json`) | [`@cyclonedx/cyclonedx-npm`](https://github.com/CycloneDX/cyclonedx-npm) | Only `dependencies` (not `devDependencies`) because the production Docker image runs `npm ci --omit=dev` |
| **Docker image layers**         | Trivy filesystem scan        | [`trivy`](https://github.com/aquasecurity/trivy)                         | Full filesystem scan of the production image, including OS packages (Alpine apk)                         |
| **GitHub Actions dependencies** | n/a (tracked via Renovate)   | Renovate (`renovate.json`)                                               | `github-actions-updates` group                                                                           |

### Out of scope (future candidates)

- gRPC protobuf definitions (`proto/credence/`) — not yet versioned as a distributable artifact.
- Soroban contract dependencies — managed on-chain, not in the Node.js dependency graph.
- Init-db SQL migration files — version-controlled but not a dependency in the supply-chain sense.

---

## Generation Cadence

| Trigger                                     | Action                                                   | Artifact Destination                                |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| **Every push / PR to `main` and `develop`** | `npm run sbom:generate` → `sbom.json`                    | GitHub Actions workflow artifact (retained 30 days) |
| **Every PR to `main` and `develop`**        | Component diff (`npm run sbom:diff`) against base branch | PR comment titled "SBOM component changes"          |
| **Nightly cron (00:00 UTC)**                | `npm run sbom:generate` + full `trivy fs` scan           | GitHub Actions workflow artifact                    |
| **Release tag (`v*`)**                      | `npm run sbom:generate` + attestation                    | Attached to GitHub Release as `sbom.json`           |

---

## Tooling Pipeline

```
npm install
    │
    ▼
┌─────────────────────────────────────┐
│ 1. npm run sbom:generate            │
│    (@cyclonedx/cyclonedx-npm)       │
│    Output: sbom.json (CycloneDX)    │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│ 2. npm run sbom:check               │
│    (scripts/sbom-validate.ts)       │
│    Validates with Zod schema        │
│    Typed error codes:                │
│    • INVALID_JSON                    │
│    • SCHEMA_MISMATCH                 │
│    • EMPTY_COMPONENTS                │
│    Fail-closed on any error → exit 1│
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│ 3. npm run sbom:diff (on PR only)   │
│    (scripts/sbom-component-diff.js) │
│    Compares vs base branch SBOM     │
│    Posts component diff to PR       │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│ 4. trivy fs . (nightly + release)   │
│    Full filesystem vulnerability     │
│    scan including OS packages       │
│    Fails on HIGH/CRITICAL findings  │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│ 5. npm run deps:audit (nightly)     │
│    (scripts/deps-audit.ts)          │
│    Combined npm audit + OSV scanner │
│    Deduplicated, threshold-gated    │
└─────────────────────────────────────┘
```

### Typed Validation Errors

The validation gate (`scripts/sbom-validate.ts`) surfaces a **discriminated union** rather than panicking or returning a generic 500:

```typescript
export type SbomValidationResult =
  | { ok: true; specVersion: string; componentCount: number }
  | { ok: false; code: "INVALID_JSON"; message: string }
  | { ok: false; code: "SCHEMA_MISMATCH"; message: string }
  | { ok: false; code: "EMPTY_COMPONENTS"; message: string };
```

Each error code has a human-readable `message` that explains what failed and why the build is blocked. This design allows callers (CLI, CI, unit tests) to branch on the failure reason without string-matching.

---

## CI/CD Integration

### Workflow: `sbom.yml` (every push/PR to `main`/`develop`)

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 20
      cache: npm
  - run: npm ci
  - run: npm run sbom:generate
  - run: npm run sbom:check
  - uses: actions/upload-artifact@v4
    with:
      name: sbom
      path: sbom.json
      retention-days: 30
```

### Workflow: `sbom-diff.yml` (every PR to `main`/`develop`)

Checks out both the PR head and base commit, generates SBOMs, runs `scripts/sbom-component-diff.js`, and posts/updates a single comment on the PR.

### Workflow: `vuln-scan.yml` (nightly)

Runs `npm audit --omit=dev`, `trivy fs .`, and `scripts/deps-audit.ts` with a HIGH severity threshold. Fails the build if any violating findings are detected.

---

## Validation Gates & Failure Modes

The following gates **fail closed** (the build stops) to ensure no vulnerability enters the supply chain undetected:

| Gate                     | Failure Mode                                                                           | Error Code           | Build Result |
| ------------------------ | -------------------------------------------------------------------------------------- | -------------------- | ------------ |
| SBOM generation          | `@cyclonedx/cyclonedx-npm` crashes or produces malformed JSON                          | `INVALID_JSON`       | ❌ Fail      |
| SBOM schema validation   | SBOM doesn't match CycloneDX schema (missing `bomFormat`, `specVersion`, `components`) | `SCHEMA_MISMATCH`    | ❌ Fail      |
| SBOM component check     | SBOM contains zero components (generation likely failed silently)                      | `EMPTY_COMPONENTS`   | ❌ Fail      |
| Trivy vulnerability scan | HIGH or CRITICAL CVE found in OS or npm packages                                       | n/a (exit 1)         | ❌ Fail      |
| Dependency audit gate    | Combined npm-audit + OSV finding at or above threshold                                 | `THRESHOLD_EXCEEDED` | ❌ Fail      |

---

## Distribution & Storage

| Environment                     | SBOM Location                       | Access                             |
| ------------------------------- | ----------------------------------- | ---------------------------------- |
| **GitHub Actions (per-commit)** | Workflow artifact (`sbom.json.zip`) | `gh run download <run-id> -n sbom` |
| **GitHub Release**              | Attached as `sbom.json`             | Release assets page / API          |
| **Local development**           | `./sbom.json` (gitignored)          | `npm run sbom:generate`            |

### Retention Policy

- **Per-commit SBOM artifacts**: 30 days (configured in `upload-artifact` step).
- **Release SBOMs**: Permanent (attached to GitHub Release).
- **Local SBOMs**: Untracked by git (listed in `.gitignore`); developer-managed.

---

## Response SLA for SBOM-Related Findings

| Severity | Definition                                                     | SLA                          | Action                                |
| -------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------------- |
| **SEV1** | SBOM validation fails on `main` (build broken)                 | Immediate — unblock pipeline | Fix validation or generation issue    |
| **SEV2** | Component diff shows unexpected dependency added in PR         | Before merge                 | Review and justify the new dependency |
| **SEV3** | Outdated SBOM in a release (release tag missing SBOM artifact) | 24 hours                     | Attach SBOM to existing release       |

---

## Local Development Commands

```bash
# Generate a CycloneDX SBOM for production dependencies
npm run sbom:generate

# Validate the generated SBOM (Zod schema + component check)
npm run sbom:check

# Compare SBOM components against a reference (default: self-diff for smoke test)
npm run sbom:diff

# Full dependency audit (npm audit + OSV scanner)
npm run deps:audit

# Production-only npm audit
npm run security:scan
```

---

## Out of Scope (Follow-up Issues)

- **Container image SBOM attestation** (cosign / DSSE): The Docker image is scanned with Trivy but an in-toto attestation is not yet attached to the container registry. This should be added when a container signing policy is defined.
- **gRPC/proto dependency tracking**: Protobuf definitions in `proto/credence/` are version-controlled but not published as an SBOM-trackable artifact.
- **Soroban contract dependencies**: The Soroban smart contract dependencies are resolved on-chain and are not part of the Node.js dependency graph. A separate Soroban SBOM strategy should be defined if the contract surface grows.

---

## See Also

- [`docs/SECURITY.md`](SECURITY.md) — Dependency vulnerability scanning SLAs and response playbook.
- [`scripts/sbom-validate.ts`](../scripts/sbom-validate.ts) — SBOM validation gate source (typed discriminated-union errors).
- [`scripts/deps-audit.ts`](../scripts/deps-audit.ts) — Combined npm-audit + OSV scanner gate.
- [`scripts/sbom-component-diff.js`](../scripts/sbom-component-diff.js) — PR component comparison script.
- [`package.json`](../package.json) — `sbom:*` and `deps:*` script definitions.
- [CycloneDX Specification](https://cyclonedx.org/specification/overview/)
