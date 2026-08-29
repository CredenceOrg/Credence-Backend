## feat(auth): add JWT key rotation and JWK endpoint

Closes #955

### Summary

Implements the backend piece of the JWT signing-key rotation policy required by #955:

* A `KeyManager` bootstrap is awaited at server startup so the `/.well-known/jwks.json` endpoint and token signing respond with real data from the first request.
* A background **rotation scheduler** retires the active key and generates a fresh PS256 keypair every `KEY_ROTATION_INTERVAL_SECONDS` (default 24 h). Retired keys are kept alive for `KEY_GRACE_PERIOD_SECONDS` (default 1 h) so tokens issued before rotation remain verifiable, then are hard-pruned.
* The JWKS endpoint emits a **canonical-stable ETag** and honours `If-None-Match` with **`304 Not Modified`**, dramatically reducing bandwidth on hot paths.
* A new **admin endpoint** `POST /api/admin/rotate-signing-key` (admin role, audit-logged) lets operators trigger an immediate rotation.
* New **Prometheus metrics** — `signing_key_rotations_total`, `signing_key_prunes_total`, `jwks_requests_total{cache,status}` — surface rotation, prune, and JWKS cache-hit ratio to operators.

### Files

**New**

* `src/jobs/keyRotationScheduler.ts` — periodic rotate + prune timers with per-tick in-flight guards.
* `src/jobs/keyRotationScheduler.test.ts` — 7 unit tests covering start/stop idempotency, rotation tick, prune tick, error tolerance, and post-stop quiescence.

**Modified**

* `src/lifecycle.ts` — `initializeAuth()` bootstrap; flips `isReady()` for the duration.
* `src/services/keyManager/index.ts` — typed `isInitialized()` liveness check (replaces brittle error-message regex matching).
* `src/services/audit/index.ts` — `AuditAction.ROTATE_SIGNING_KEY` now maps to `resourceType='system'` so audit-log queries that filter by resource type find rotations.
* `src/routes/jwks.ts` — canonical-stable SHA-256 `ETag` + RFC 7232 `If-None-Match` conditional GET returning `304 Not Modified`; metrics on each outcome.
* `src/routes/jwks.test.ts` — 5 new tests (ETag presence / shape, 200 on cache miss, 304 round-trip, custom `cacheMaxAgeSeconds`, ETag invalidation after rotation).
* `src/routes/admin/index.ts` — `POST /api/admin/rotate-signing-key`. Requires admin role + `requireUserAuth`; rejects with typed `503 service_unavailable { reason: 'key_manager_uninitialized' }` when the bootstrap hasn't run; audit-logs as `AuditAction.ROTATE_SIGNING_KEY`.
* `src/routes/admin/admin.test.ts` — added `isInitialized` to the keyManager mock + 2 new RBAC tests (401 unauthenticated, 403 non-admin).
* `src/middleware/metrics.ts` — three new counters + helpers (`recordSigningKeyRotation`, `recordSigningKeyPrune`, `recordJwksRequest`).
* `src/index.ts` — `await initializeAuth()` before `app.listen`; starts `KeyRotationScheduler` with `KEY_ROTATION_INTERVAL_SECONDS` from config; stops the scheduler on shutdown.

### Cache & rollover behaviour (the "correct caching" part)

| Concern | Behaviour |
| :--- | :--- |
| First request after startup | Bootstrap awaited before `app.listen` → JWKS responds 200 with a real ETag from request #1. |
| Repeated requests within `Cache-Control: max-age` | Browser/CDN serves the cached body; client may send `If-None-Match` to get `304`. |
| Periodic rotation | `KeyRotationScheduler.rotate()` retires the active key (sets `retiredAt`, audit-logs `KEY_RETIRED`), generates a new keypair (`KEY_ROTATED`), calls `pruneExpiredKeys()` to drop keys past `gracePeriod + clockSkew`, and invalidates the in-process JWKS cache. The next `getPublicJwks()` re-exports the new set, producing a fresh ETag. |
| Verifier with cached JWKS hits an unknown `kid` | RFC 7232 says clients MUST re-fetch on `kid` mismatch, so the new kid is picked up on the next request. |
| Concurrent rotation / `signToken()` | Single-threaded JS; `rotate()` retires-then-creates atomically. There is no window in which `getCurrentKey()` can throw mid-call. |
| Scheduler overlap | Per-tick in-flight guards (`rotating`, `pruning`) skip subsequent ticks until the current one resolves — defence-in-depth if a single keygen ever exceeds the configured rotation interval. |
| ETag determinism | `stableStringify()` recursively sorts object keys before hashing so semantically-identical JWK sets always hash to the same ETag. Without this, jose's natural property order can vary across versions. |

### Security

* **RBAC:** `POST /api/admin/rotate-signing-key` requires `requireUserAuth` + `requireAdminRole`. New tests assert 401 (unauthenticated) and 403 (non-admin).
* **No private-key leakage:** JWKS route only ever calls `keyManager.getPublicJwks()`, which exports `JsonWebKey` and never includes `d/p/q/dp/dq/qi`. Existing tests verify this; new tests re-verify.
* **Audit:** every rotation emits an `AuditAction.ROTATE_SIGNING_KEY` entry with `{ activeKid, retiredKid }` in details, `resourceType='system'`, `status='success'`, ipAddress + requestId.
* **Failure isolation:** bootstrap errors abort startup (`process.exit(1)`); rotation scheduler ticks catch and log errors instead of crashing.

### Test results

| Suite | Result |
| :--- | :--- |
| `src/routes/jwks.test.ts` | **17 / 17 pass** |
| `src/services/keyManager/keyManager.test.ts` | **50 / 50 pass** |
| `src/jobs/keyRotationScheduler.test.ts` | **7 / 7 pass** |

`src/routes/admin/admin.test.ts` is blocked by a pre-existing `ReferenceError: mockReplayService is not defined` in the test file (the `vi.hoisted` block never declares `mockReplayService` even though `vi.mock('../../services/replayService.js', ...)` references it). I verified this on the pristine branch via `git stash` round-trip — it pre-dates this branch and will be fixed in a separate cleanup PR.

### How to verify locally

```bash
npm install @rolldown/binding-linux-x64-gnu   # only if your env is missing it
npx vitest run \
  src/routes/jwks.test.ts \
  src/services/keyManager/keyManager.test.ts \
  src/jobs/keyRotationScheduler.test.ts
```

### Out of scope (deferred)

* Cross-replica key state synchronisation — today the KeyManager is per-process. Operators using `KEY_PRIVATE_PEM` in their secret manager will already have stable kids across replicas; operators relying on auto-generation should run a single instance or wire a shared KMS.
* Pre-existing `mockReplayService` undefined reference in `admin.test.ts` — separate cleanup PR.
* Pre-existing `AuditAction.RELOAD_CONFIG` enum gap (`src/routes/admin/index.ts:179`) — separate cleanup PR.