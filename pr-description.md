# docs(security): add secret-rotation posture document

## Description

This PR adds `docs/SECRETS.md`, a contributor-facing document that captures the secret-rotation posture for the Credence Backend.

The intent is to move rotation policy off of tribal knowledge and into the repository, so that reviewers can verify actual behaviour against the documented intent, new contributors can orient themselves without reading commit history, and the support team can answer common questions without paging an engineer.

Closes #

## Changes

- **`docs/SECRETS.md`** *(new)*: Describes all four secret types managed by the platform — Evidence KEK, JWT signing keys, integration API keys, and webhook signing secrets — with concrete storage location, rotation cadence, blast radius and mitigation notes, and runnable CLI / HTTP examples for each.
- **`README.md`**: Links `docs/SECRETS.md` from the **Security** section so it is discoverable from the repo's top-level entry point.
- **`docs/security.md`**: Adds a **See Also** section at the end, cross-linking `docs/SECRETS.md` and `docs/kms-rotation-runbook.md`.

## Secret types documented

| Secret | Mechanism | Cadence | Blast radius |
|---|---|---|---|
| Evidence KEK | `KekManager` + CLI (`rotate-kms-key.ts`), dual-control | Manual / on-demand | Evidence records encrypted under the compromised version |
| JWT signing key | `KeyManager` in-memory scheduler | Automated every 24 h | Token forgery within the key's active window |
| Integration API key | `ApiKeyRotationService` via REST | Manual / on-demand | Endpoints within the key's granted scope |
| Webhook signing secret | `WebhookRotationService` via REST, 24 h grace period | Manual / on-demand | Forged webhook payloads to the subscriber's endpoint |

## Verification

```bash
npx tsc --noEmit   # no TypeScript errors introduced
npm test           # full vitest suite passes
npm run security:scan   # npm audit --omit=dev
npm run sbom:check      # CycloneDX SBOM schema validation
```

## Checklist

- [x] The change matches the summary above.
- [x] The new document is linked from `README.md` and `docs/security.md`.
- [x] No new env vars, Zod schemas, or OpenAPI entries are required (documentation-only change).
- [x] Lint, type-check, and tests all pass locally.
- [x] PR description references this issue with `Closes #`.
