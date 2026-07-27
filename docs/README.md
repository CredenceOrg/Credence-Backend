# Documentation Index

This directory contains additional documentation for the Credence Backend.

- **[API & Endpoint Deprecation Policy](DEPRECATION_POLICY.md)** – endpoint deprecation support windows, communication cadence, and client migration guidelines.
- **[API Stability & Versioning Discipline](API_STABILITY.md)** – versioning discipline, breaking change definitions, and SemVer rules.
- **[Blameless Postmortem Template](POSTMORTEM_TEMPLATE.md)** – template for incident reviews with timeline, impact, root cause analysis, and action items.
- **[Replay & Inspection Guide (Operator)](replay_and_inspection.md)** – when to replay failed events and how to inspect prior failures.
- **[Replay‑Safe Handlers & Side‑Effects](REPLAY_SAFE_HANDLERS.md)** – ensuring side‑effects are safe during retries.
- **[Idempotency Guard](IDEMPOTENCY_GUARD.md)** – replay protection for HTTP requests.
- **[Incoming Webhook Security & Posture](WEBHOOK_RECEIVE.md)** – HMAC-SHA256 signature verification, 5-minute replay window, and CIDR allowed origins.
- **[Event Ordering Guarantees](EVENT_ORDERING.md)** – ordering guarantees and guidelines for downstream consumers.
- **[Environment Deployment Guide](DEPLOY.md)** – step-by-step deployment instructions for development, staging, and production environments.
- **[Caching Layer](caching.md)** – Redis caching architecture, `CacheService` API reference, and stampede protection.
- **[Cache Invalidation Strategy](CACHE_INVALIDATION.md)** – invalidation patterns and read-after-write consistency across replicas.
- **[Cache Inventory](CACHE_INVENTORY.md)** – every cache namespace in the codebase and its TTL, in one table.
- **[Grafana Metrics & Dashboards Reference](METRICS_DASHBOARDS.md)** – detailed mapping of Grafana dashboard panels to Service Level Indicators (SLIs) and Objectives (SLOs) for operators.
- **[Rate Limiting Design](RATE_LIMITING_DESIGN.md)** – tenant/IP/key rate-limiting windows and tiers.
- **[Input Validation Guide](INPUT_VALIDATION.md)** – how we validate request inputs (path params, query, body) and surface errors.
