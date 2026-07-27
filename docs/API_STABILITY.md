# API Stability & Versioning Discipline

**Audience:** Downstream integrators (SDK consumers, webhook subscribers, API clients)

This document defines the versioning discipline for the Credence public REST API. It is the contract reviewers and integrators use to evaluate whether a change is safe to adopt.

---

## Versioning Scheme

We follow **Semantic Versioning (SemVer 2.0.0)** for the public REST API, expressed in the OpenAPI spec `info.version` field and the npm package version.

| Component | Meaning | Example |
|-----------|---------|---------|
| **MAJOR** | Breaking change: removed/renamed fields, changed response shape, removed endpoints, changed HTTP status codes for success cases | `1.0.0` → `2.0.0` |
| **MINOR** | Backward-compatible addition: new endpoints, new optional fields, new enum values, new optional query params | `1.0.0` → `1.1.0` |
| **PATCH** | Backward-compatible fix: bug fixes, documentation updates, internal refactors, performance improvements | `1.0.0` → `1.0.1` |

The API version is **not** embedded in the URL path (`/api/...` not `/api/v1/...`). Versioning is communicated through:
- `info.version` in `docs/openapi.yaml`
- `package.json` `version` field (published to npm as `@credence/backend`)
- `X-Credence-Version` response header on all API responses (git SHA + build timestamp)

---

## What Constitutes a Breaking Change (MAJOR)

| Change Type | Example | Version Bump |
|-------------|---------|--------------|
| Remove an endpoint | `DELETE /api/attestations/:id` removed | MAJOR |
| Remove a response field | `attestationCount` removed from `/api/trust/:address` | MAJOR |
| Rename a response field | `bondedAmount` → `bondAmountWei` | MAJOR |
| Change field type | `score: number` → `score: string` | MAJOR |
| Change HTTP success status | `200` → `201` for same endpoint | MAJOR |
| Make required field optional | `address` required → optional in request body | MAJOR |
| Remove enum value | `status: "active" \| "pending"` → only `"active"` | MAJOR |
| Change validation rules | Address format relaxed from EIP-55 to any hex | MAJOR |

---

## What Is Backward-Compatible (MINOR/PATCH)

| Change Type | Example | Version Bump |
|-------------|---------|--------------|
| Add new endpoint | `POST /api/verification/verify` added | MINOR |
| Add optional response field | `agreedFields` added to `/api/trust/:address` | MINOR |
| Add optional query parameter | `?includeHistory=true` on `/api/trust/:address` | MINOR |
| Add new enum value | `status: "active" \| "pending" \| "archived"` | MINOR |
| Relax validation (add accepted format) | Accept both `0x...` and `0X...` prefixes | MINOR |
| Fix bug without changing contract | Correct `bondStart` timezone handling | PATCH |
| Improve performance/latency | Caching layer added to `/api/health` | PATCH |
| Update documentation only | Fix typo in OpenAPI description | PATCH |

---

## Deprecation Policy

> See **[docs/DEPRECATION_POLICY.md](DEPRECATION_POLICY.md)** for full details on support windows, communication cadence, and client migration guidelines.

### Deprecation Window: **6 months minimum**

When a breaking change is planned:

1. **Announce** — Open a GitHub issue labeled `deprecation` with:
   - What is being deprecated (field, endpoint, parameter)
   - Replacement (new field, endpoint, parameter)
   - Target removal version (next MAJOR)
   - Migration guide link

2. **Mark in OpenAPI** — Add `deprecated: true` to the schema/parameter/operation in `generate-openapi.ts`

3. **Emit deprecation header** — Responses for deprecated endpoints/fields include:
   ```
   Deprecation: true
   Sunset: Sat, 01 Jan 2027 00:00:00 GMT
   Link: <https://github.com/CredenceOrg/Credence-Backend/issues/XXX>; rel="deprecation"
   ```

4. **Support both** — During the window, old and new coexist. Old behavior continues to work.

5. **Remove** — After the sunset date, remove in the next MAJOR release.

### Example Deprecation Flow

**Scenario:** Rename `bondedAmount` → `bondAmountWei` in `/api/trust/:address` response.

| Date | Version | Action |
|------|---------|--------|
| 2026-07-01 | 1.5.0 | Add `bondAmountWei` field; mark `bondedAmount` deprecated in OpenAPI; emit `Deprecation` header |
| 2026-07-01 | 1.5.0 | Publish migration guide in `docs/migration/v1-to-v2.md` |
| 2027-01-01 | 2.0.0 | Remove `bondedAmount`; `bondAmountWei` is the only field |

---

## Version Bumping Procedure

### Automated (CI)

On merge to `main`, the `release` workflow:
1. Reads conventional commit messages since last tag
2. Determines version bump (feat → MINOR, fix → PATCH, BREAKING CHANGE → MAJOR)
3. Creates git tag `v<version>`
4. Publishes to npm (if configured)
5. Updates `docs/openapi.yaml` `info.version`

### Manual Override

Maintainers can force a version bump by pushing a tag:
```bash
git tag v1.2.0
git push origin v1.2.0
```

### Local Verification

Before pushing, run:
```bash
npm run build          # compiles TypeScript
npx tsc --noEmit       # type-check
npm test               # test suite
npm run security:scan  # npm audit
npm run sbom:check     # SBOM validation
```

---

## OpenAPI as Source of Truth

The generated `docs/openapi.yaml` is the **authoritative contract**.

- **Generated from:** `scripts/generate-openapi.ts` (Zod schemas → OpenAPI)
- **Regenerated on:** Every CI run via `npm run generate:openapi`
- **Drift detection:** `openapi-drift` gate in CI fails if checked-in spec diverges from generated

Integrators should:
1. Pin to a specific OpenAPI spec version (e.g., `docs/openapi.yaml@v1.5.0`)
2. Regenerate SDKs from that pinned spec
3. Subscribe to `deprecation` issues for advance notice

---

## Error Code Stability

Error codes follow the same discipline:

| Change | Version Bump |
|--------|--------------|
| New error code added | MINOR |
| Error code removed | MAJOR (after deprecation window) |
| Error code meaning changed | MAJOR |
| HTTP status code for error changed | MAJOR |

Error codes are documented in `docs/error-codes.md` with a `deprecated` flag and `replacedBy` field.

---

## SDK Versioning

The TypeScript SDK (`src/sdk/`) is generated from the OpenAPI spec and versioned **in lockstep** with the API:

| API Version | SDK Version |
|-------------|-------------|
| 1.5.0 | 1.5.0 |
| 2.0.0 | 2.0.0 |

SDK releases are published to npm as `@credence/sdk`. Breaking changes in the SDK follow the same deprecation window.

---

## Webhook Payload Versioning

Webhook payloads are versioned independently via the `version` field in the envelope:

```json
{
  "version": "1.0",
  "eventId": "evt_abc123",
  "eventType": "bond.withdrawn",
  "timestamp": "2026-07-01T12:00:00.000Z",
  "payload": { ... }
}
```

| Change | Version Bump |
|--------|--------------|
| New event type added | MINOR |
| New optional field in payload | MINOR |
| Required field removed/renamed | MAJOR (new envelope version) |
| Payload shape changed | MAJOR (new envelope version) |

Subscribers specify the envelope version when registering the webhook. Old versions are supported for 12 months after a new envelope version is released.

---

## Migration Guides

Each MAJOR release includes a migration guide at `docs/migration/v<major>-to-v<major+1>.md` with:

- Breaking changes list
- Before/after code examples
- Automated codemod (if applicable)
- Timeline for deprecation completion

Example: `docs/migration/v1-to-v2.md`

---

## Quick Reference for Reviewers

When reviewing a PR, check:

| Question | Where to Verify |
|----------|-----------------|
| Does this change the OpenAPI spec? | `npm run generate:openapi` diff |
| Is it a breaking change? | Compare against "Breaking Change" table above |
| If breaking: is there a deprecation issue? | GitHub issue with `deprecation` label |
| If breaking: is `Deprecation` header emitted? | Check route handler for `res.set('Deprecation', 'true')` |
| Is the version bump correct? | Conventional commit message or manual tag |
| Are error codes stable? | Check `docs/error-codes.md` diff |
| Is SDK regenerated? | `npm run build:sdk` (if script exists) |

---

## Related Documents

- **API Reference:** [`docs/api.md`](api.md)
- **Deprecation Policy:** [`docs/DEPRECATION_POLICY.md`](DEPRECATION_POLICY.md)
- **OpenAPI Spec:** [`docs/openapi.yaml`](openapi.yaml)
- **Error Codes:** [`docs/error-codes.md`](error-codes.md)
- **SDK Documentation:** [`docs/sdk.md`](sdk.md)
- **Webhooks:** [`docs/webhooks.md`](webhooks.md)
- **Migration Guides:** [`docs/migration/`](migration/)