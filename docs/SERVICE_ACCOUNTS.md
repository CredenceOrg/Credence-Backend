# Service Accounts & Permissions

> **Audience:** Security auditors, platform operators, and contributors reviewing access controls.
> **Last updated:** 2026-07-25

---

## Overview

Credence Backend uses two categories of service accounts to access its APIs and infrastructure:

| Category | Authentication | Scope Model | Examples |
|---|---|---|---|
| **Kubernetes Service Accounts** | K8s IAM / RBAC | Cluster-wide role bindings | `default` (legacy), dedicated SA per service (recommended) |
| **API Key Service Accounts** | `X-API-Key` / `Authorization: Bearer` | Granular scopes (`ApiScope` enum) | `outbox-publisher`, `horizon-listener`, `webhook-sender` |

This document lists every known service account, the permissions it holds, and the threat model for each.

---

## 1. Kubernetes Service Accounts

### 1.1 `default` (legacy — no dedicated SA)

| Field | Value |
|---|---|
| **Name** | `default` |
| **Namespace** | `credence` |
| **Used by** | All pods in the `credence` namespace (API server, workers, listeners) |
| **Permissions** | Inherits the cluster-level `default` ServiceAccount with no explicit `RoleBinding` or `ClusterRoleBinding` defined in the manifests |
| **Secret access** | Mounts `credence-backend-secret` via environment variables (`DATABASE_PASSWORD`, `API_KEY`) |
| **Threat if compromised** | An attacker who compromises a pod using the `default` SA gains the pod's full network identity within the cluster. Without explicit RBAC bindings, the blast radius is limited to what the pod's workload already does, but there is no fencing between pods sharing the same SA. |

### 1.2 Recommended: Dedicate a ServiceAccount per workload

The manifests in `k8s/` do not yet define a dedicated `ServiceAccount`. Each workload **should** have its own SA with a `Role` + `RoleBinding` scoped to the minimum set of Kubernetes resources it needs (e.g., only `configmaps/get` for the API, only `secrets/get` for the worker).

| Workload | Recommended SA | Recommended Role |
|---|---|---|
| `credence-backend` (API) | `credence-api` | Read `credence-backend-config` ConfigMap, read `credence-backend-secret` Secret |
| `credence-backend` (worker jobs) | `credence-worker` | Same as API + write to `listener_leases` table (via DB, not K8s) |
| `credence-backend` (Horizon listener) | `credence-listener` | Same as API |

> **TODO:** Create `k8s/serviceaccount.yaml`, `k8s/role.yaml`, and `k8s/rolebinding.yaml` and reference `serviceAccountName` in `k8s/deployment.yaml`.

---

## 2. API Key Service Accounts

API keys are the primary mechanism for service-to-service authentication. Each key is issued with an explicit set of **scopes** (`ApiScope` enum in `src/middleware/auth.ts`). Keys prefixed with `cr_` follow the format `cr_<64 hex chars>`.

### 2.1 Scope Reference

| Scope | Description | Used by |
|---|---|---|
| `trust:read` | Read trust scores and bond data | All public-facing services |
| `attestations:read` | List and count attestations | Audit, reporting services |
| `attestations:write` | Create or revoke attestations | Attestation ingestion service |
| `payouts:write` | Initiate payout / settlement operations | Settlement reconciliation worker |
| `reports:generate` | Trigger and poll report generation | Report generation worker |
| `exports:read` | Download report artifacts and audit-log exports | Export/analytics worker |
| `webhooks:admin` | Rotate/revoke webhook signing secrets | Webhook management admin |
| `outbox:reinject` | Reinsert quarantined outbox events | Outbox repair worker |
| `admin:read` | Read admin resources (users, audit logs, failed events) | Admin dashboard, audit reader |
| `admin:write` | Assign roles, revoke keys, impersonate, replay events | Admin operations |
| `flags:read` | Read feature flags | Feature flag service |
| `flags:write` | Mutate feature flags | Feature flag admin |
| `bond:read` | Read bond data | Bond query service |
| `bond:write` | Write bond data | Bond mutation service |

### 2.2 Known Service Accounts (API Keys)

| Service Account | Scopes | Purpose | Threat if Compromised |
|---|---|---|---|
| `horizon-listener` | `trust:read`, `attestations:read` | Ingests Stellar Horizon events (bond withdrawals, attestation events) and writes to the database | Read-only exposure; attacker can query trust scores and attestation counts but cannot modify data. Low blast radius. |
| `outbox-publisher` | `outbox:reinject` | Polls the outbox table and publishes events to external subscribers | Can re-inject quarantined events; if compromised, could replay or duplicate outbound webhooks. However, events are idempotency-keyed, so replay is detectable. |
| `webhook-sender` | *(none — outbound only)* | Sends HTTP webhook notifications to registered subscriber endpoints | Does not hold an API key; makes outbound calls only. Compromise would affect downstream subscribers, not Credence data. |
| `analytics-refresher` | `trust:read`, `attestations:read`, `exports:read` | Runs scheduled analytics refresh jobs and writes aggregated metrics | Read-only; can access trust/bond/export data but cannot modify or delete. Moderate exposure — analytics data may contain aggregated insights. |
| `data-retention` | `admin:read` | Runs the `DataRetentionJob` to crypto-shred expired evidence records | Read-only access to audit logs and metadata; does not access encrypted evidence payloads directly. |
| `key-rotation-worker` | `admin:read` | Rotates JWT signing keys and API keys on a schedule | Read-only; does not issue or revoke keys itself — it only rotates signing material. |
| `settlement-reconciler` | `payouts:write`, `trust:read`, `bond:read` | Reconciles on-chain settlement state with DB records | **High impact** — can initiate payouts. Must be restricted to the dedicated settlement service account. |
| `impersonation-service` | `admin:write` | Issues short-lived impersonation tokens for admin debug/support | **Critical impact** — can temporarily assume any user's identity. Must be restricted to admin role only (enforced at route level via `requireAdminRole`). |

### 2.3 Impersonation Tokens

| Field | Detail |
|---|---|
| **Mechanism** | Admin users can issue short-lived impersonation tokens via `POST /api/admin/impersonate` |
| **Default TTL** | 900 seconds (15 minutes) |
| **Maximum TTL** | 3600 seconds (1 hour) |
| **Scope** | The token inherits the target user's role and tenant |
| **Audit** | Every issuance and revocation is logged in the audit stream with `AuditAction.ISSUE_IMPERSONATION_TOKEN` / `REVOKE_IMPERSONATION_TOKEN` |
| **Threat** | If an admin's credentials are compromised, the attacker can impersonate any user for up to 1 hour. Mitigated by: mandatory `reason` field, audit logging, and mandatory admin role at the route level. |

---

## 3. Permission Enforcement

### 3.1 API Level

All API endpoints are protected by one of three middleware factories (`src/middleware/rbac.ts`):

| Middleware | Effect |
|---|---|
| `requireRole('admin')` | Only callers with the `admin` role |
| `requireMinRole('verifier')` | Callers with `verifier` or `admin` role |
| `requireAnyRole()` | Any authenticated caller (blocks unauthenticated) |

### 3.2 API Key Level

API keys are validated via `requireApiKey(scope)` middleware (`src/middleware/auth.ts`). The middleware checks:
1. The key exists and is active (hash lookup in DB or in-memory store).
2. The key's granted scopes satisfy the required scope.
3. If the key is revoked, requests are rejected with `401`.

### 3.3 Deny-by-Default

The scope enforcement follows a **deny-by-default** policy:
- If a key's scopes do not cover the required scope → `403 Forbidden` before the handler executes.
- If a key is missing entirely → `401 Unauthorized`.
- No scope escalation is possible: a key can only be rotated to the same or narrower scope set.

---

## 4. Threat Model

### 4.1 Attacker Gains

| If… | Attacker gets… | Blast radius |
|---|---|---|
| A Horizon listener API key is compromised | Read access to trust scores and attestation counts | Low — read-only data exposure |
| The `default` K8s SA is used by all pods | No direct K8s permissions (no RoleBinding defined), but pod identity is shared | Medium — lateral movement within the namespace if RBAC is later added |
| A settlement reconciler key is compromised | Ability to initiate payouts | **High** — financial loss |
| An admin API key is compromised | Full control over roles, keys, impersonation, and event replay | **Critical** — complete platform takeover |
| An impersonation token is intercepted | Temporary identity of any user for up to 1 hour | High — user-level data access and actions |

### 4.2 Mitigations in Place

| Threat | Mitigation |
|---|---|
| Stolen API key | Key revocation is immediate and atomic; old key cannot be used after rotation |
| Compromised service account | Scope is limited to least-privilege; no key can escalate beyond its granted scopes |
| Impersonation abuse | Mandatory `reason` field, 1-hour hard cap on TTL, audit logging of every action |
| Lateral movement in K8s | No explicit RoleBindings yet (see 1.2 above); work item to add per-pod SAs |
| Replay of outbound webhooks | Idempotency keys on all outbox events; duplicate delivery is detected and deduplicated |

### 4.3 Gaps (This Document Closes)

| Gap | Risk | Status |
|---|---|---|
| No dedicated Kubernetes ServiceAccount per workload | All pods share the `default` SA; no RBAC fencing | **Documented** — follow-up PR to add SA/Role/RoleBinding manifests |
| No formal registry of service accounts and their scopes | Auditors cannot verify least-privilege without reading every source file | **This document** |
| Settlement reconciler has `payouts:write` without a dedicated SA name | Key could be misidentified as a user key | **Documented** — recommend naming the key `svc-settlement-reconciler` |

---

## 5. Related Documents

| Document | Covers |
|---|---|
| [`docs/SECRETS.md`](SECRETS.md) | Secret types, rotation cadence, blast radius |
| [`docs/api-keys.md`](api-keys.md) | API key format, scope enforcement, subscription tiers |
| [`docs/rbac.md`](rbac.md) | Role hierarchy, middleware factories, route protection |
| [`docs/SEURITY.md`](SECURITY.md) | Full security architecture, CORS, rate limiting |
| [`k8s/`](../k8s/) | Kubernetes deployment manifests |

---

## 6. Maintaining This Document

When a new service account is created:
1. Add it to the table in **Section 2.2**.
2. Record its scopes, purpose, and threat model.
3. Update the threat table in **Section 4.1**.
4. Update the mitigations table in **Section 4.2**.
5. Run `npm run lint && npm test` to verify nothing is broken.
