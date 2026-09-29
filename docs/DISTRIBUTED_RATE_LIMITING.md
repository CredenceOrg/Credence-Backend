# Distributed rate-limit correctness

The API rate limiter is a shared security boundary. A process-local counter
allows a client to multiply its budget by sending requests to different
instances, and a multi-command increment/expiry sequence can leave a bucket
without an expiry if a worker stops between commands.

## Guarantees

The middleware now uses one Redis Lua script for each bucket decision. Redis
executes the script atomically on its command thread:

1. increment the fixed-window counter;
2. set the expiry only for the first increment; and
3. read the remaining TTL for response headers.

The limit decision is made from the returned count. If 10 requests are allowed,
exactly 10 requests can observe a count at or below 10 in a shared window; the
11th and later requests receive `429`. Multiple application instances use the
same Redis namespace and therefore share this decision.

Small test adapters that only implement `INCR`, `EXPIRE`, and `TTL` remain
supported through a compatibility path. The production `redis` client exposes
`EVAL`, so deployed instances use the atomic path. An adapter for a production
deployment should implement `eval`; the fallback must not be mistaken for a
cross-process transaction.

## Key dimensions

Each tenant bucket includes both the resolved identity and the HTTP route. The
identity is an authenticated tenant/API-key owner where available, otherwise
the hashed API key, bearer token, or socket peer fallback. Each API-key bucket
includes the key ID, subscription tier, and route. The route dimension uses the
HTTP method, Express base URL, and path.

The user-controlled dimensions are hashed before being placed in Redis keys.
This provides three useful properties:

- tenant A cannot collide with tenant B because their complete identities are
  independently represented in the digest;
- `/api/report` cannot exhaust `/api/export` when route-scoped limits are used;
  and
- arbitrary tenant IDs and paths cannot create unbounded or separator-
  ambiguous Redis key names.

The digest is a key representation, not an authorization decision. Tenant
identity must still come from trusted authentication or gateway context. A
caller-provided tenant header is not used by the production extractor.

## Two-bucket policy

For an authenticated API key, the middleware evaluates:

| Bucket | Dimensions | Purpose |
| --- | --- | --- |
| Tenant | namespace, tenant identity, route | Shared ceiling for all keys owned by a tenant. |
| API key | namespace, key ID, tier, route | Prevents one key from consuming the tenant's per-key allowance. |

The tenant bucket is checked first. This preserves the existing rejection
precedence and avoids doing a second operation when the tenant has already
exhausted its shared budget. Remaining headers report the tighter of the two
budgets when both buckets are present.

Tier changes are part of the API-key bucket identity. A key upgraded from free
to pro receives a fresh tier-scoped bucket instead of inheriting a counter
created under the old ceiling. Tenant overrides replace the tier limit and
window for the tenant bucket decision, and the selected window is passed to
the atomic script.

## Forwarded-IP threat model

Application code must not use the leftmost `X-Forwarded-For` value as the
security identity. When a request reaches the process through a reverse proxy,
that value can be supplied by the caller and changed on every attempt.

`getClientIp` uses `req.socket.remoteAddress`, the TCP peer that delivered the
request. In a correctly configured deployment this is the trusted proxy; when
the application is directly exposed it is the client address. Proxy
normalization belongs at the trusted edge. Express's `trust proxy` setting
must be reviewed together with the network topology before deployment.

## Dependency failure

Redis failure is an explicit policy decision:

- `failOpen: false` returns `503 SERVICE_UNAVAILABLE` and blocks the request.
  Use this for sensitive routes where silently disabling protection is unsafe.
- `failOpen: true` allows the request through with headers showing the full
  configured budget. Use this only for routes where availability is more
  important than strict abuse prevention, and alert on the degraded mode.

Both modes are observable through the `rate_limit_rejected_total` metric for
fail-closed rejection and application logs/health signals for dependency
health. A Redis outage must not silently look like a successful rate-limit
decision.

Tenant override lookup failure is handled separately: the middleware falls
back to the configured tier ceiling, then still performs the shared Redis
check. This avoids making a control-plane outage disable the data-plane guard.

## Expiry and boundary behavior

The first increment assigns the configured expiry inside the same atomic
script. Subsequent increments do not extend the fixed window. If the key has
expired, Redis starts a new window and the first increment assigns a new TTL.

The middleware reports a positive TTL in `Retry-After` and `X-RateLimit-Reset`.
If Redis reports a non-positive TTL due to an expiry race, the implementation
uses the configured window as a safe header fallback. It never treats a missing
TTL as permission to skip the counter.

Fixed windows intentionally have a boundary burst characteristic: traffic at
the end of one window and the beginning of the next can be admitted by two
different windows. This is compatible with the existing API contract. A future
sliding-window design would be a separate migration because it changes quotas,
Redis data shape, and client retry timing.

## Compatibility and migration

The public middleware factory and `rateLimit` helper signatures remain
compatible. Existing minimal Redis test doubles continue to work. Redis key
names now use the `v2` segment and include route scope, so existing counters
are intentionally not carried into the new representation. This gives every
deployment a clean window after rollout and avoids mixing old and new key
semantics.

No database migration is required for the counter itself. Tenant override
records continue to use the existing `tenant_rate_limit_overrides` table. The
application should deploy the code and Redis script support together; a mixed
fleet may temporarily use the compatibility command path while instances are
upgraded.

## Rollback

Rollback to the previous application version is safe at the data-schema level,
but it changes the key namespace and can restore the previous weaker race
behavior. During a rollback, operators should expect fresh counters and monitor
request rejection rates. Do not manually delete all Redis keys as a routine
rollback step; expiry will retire the versioned buckets naturally.

If Redis is unavailable during rollout, keep fail-closed behavior for sensitive
routes. If availability requires fail-open for a non-sensitive route, record
that decision in deployment configuration and set an alert with an owner and
time limit.

## Validation matrix

The distributed rate-limit tests exercise:

- concurrent requests distributed across two middleware instances sharing one
  Redis object;
- exact admission at the limit and rejection beyond it;
- atomic script contents and one-key execution;
- tenant isolation and collision resistance at the middleware boundary;
- route isolation for distinct HTTP paths;
- tenant-specific limits and TTLs;
- fixed-window expiry and reset;
- forwarded-IP spoofing attempts;
- fail-closed dependency behavior; and
- explicit fail-open behavior.

The existing route suite remains unchanged and continues to cover tier limits,
per-key limits, tenant overrides, headers, metrics, fallback adapters, and
legacy helper behavior. No security or CI check is disabled by this change.

## Operational checklist

Before enabling the release:

1. Verify every instance points at the same Redis deployment and namespace.
2. Confirm the Redis role permits `EVAL`, `INCR`, `EXPIRE`, and `TTL`.
3. Confirm sensitive routes resolve to `failOpen: false`.
4. Exercise two instances with the same tenant and route.
5. Verify tenant A and tenant B receive independent counters.
6. Send a spoofed forwarded IP and confirm the socket identity remains stable.
7. Observe the rejection and dependency metrics during a controlled limit test.
8. Confirm `Retry-After` matches the selected override or configured window.
9. Keep the prior release available while watching the new `v2` key namespace.

The key correctness rule is simple: every request that can consume a quota
must make its decision against a shared, atomically incremented bucket whose
identity includes the intended tenant and route.

## Review notes for future adapters

An adapter should keep the `eval` operation on the same Redis connection path
as the counters. A client-side transaction that queues commands but allows a
different process to interleave between them does not provide the same
guarantee. The script must remain constant and receive only the key and window
as arguments; do not interpolate tenant IDs, paths, or other request data into
Lua source.

The script intentionally assigns expiry only when the returned count is one.
Refreshing expiry on every request would turn a fixed window into a sliding
window and would allow a continuously active client to retain a bucket forever.
Changing that behavior requires a new contract, new capacity analysis, and
new operational alerts.

When adding another bucket dimension, update all three places together: the
identity derivation, the key-format documentation, and the multi-instance
test. A dimension omitted from one bucket can create surprising precedence
behavior even when the other bucket is correctly isolated. Keep secrets out of
labels, logs, and Redis key values; only digests or non-sensitive stable IDs
should be emitted to infrastructure systems.

The route path is evaluated after Express has mounted the middleware. If a
future router uses a wildcard or rewrites `req.path`, the route identity must
be reviewed before enabling `includeRoute` for that router. The method is part
of the identity so a read and a write endpoint cannot unintentionally share a
quota when route scope is enabled.

The fail-open option is deliberately visible at configuration construction.
Do not catch a Redis error inside the Lua adapter and return a synthetic count:
that would make dependency failure indistinguishable from an admitted request.
Instead, let the middleware apply the configured policy and expose the
degraded state to the deployment's health and alerting systems.

For incident response, preserve the namespace, route, tenant digest, window
ID, and configured limit from a rejected request. Those fields identify the
bucket without exposing the tenant's raw credential. A support workflow can
then compare the Redis TTL and counter value against the response headers and
determine whether the issue is quota exhaustion, clock skew, or dependency
failure.

The implementation is intentionally additive. Existing callers can continue
to use the factory without `includeRoute`, while the application-wide API
middleware opts into route scope explicitly. The authentication limiter keeps
its tenant-wide behavior because login and refresh are one shared abuse
surface. This split is documented in code through the option rather than
hidden in route-name conditionals.

The compatibility path is useful for isolated unit tests and local adapters,
but a production readiness check should assert that the selected Redis client
supports `EVAL`. If that check fails, choose fail-closed for sensitive traffic
and page the operator rather than silently accepting a weaker distributed
guarantee.
