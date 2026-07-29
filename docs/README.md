# Documentation Index

This directory contains additional documentation for the Credence Backend.

- **[API & Endpoint Deprecation Policy](DEPRECATION_POLICY.md)** – endpoint deprecation support windows, communication cadence, and client migration guidelines.
- **[API Stability & Versioning Discipline](API_STABILITY.md)** – versioning discipline, breaking change definitions, and SemVer rules.
- **[Blameless Postmortem Template](POSTMORTEM_TEMPLATE.md)** – template for incident reviews with timeline, impact, root cause analysis, and action items.
- **[Replay & Inspection Guide (Operator)](replay_and_inspection.md)** – when to replay failed events and how to inspect prior failures.
- **[Replay‑Safe Handlers & Side‑Effects](REPLAY_SAFE_HANDLERS.md)** – ensuring side‑effects are safe during retries.
- **[Idempotency Guard](IDEMPOTENCY_GUARD.md)** – replay protection for HTTP requests.
- **[API Key Scopes](SCOPES.md)** – every available scope, which endpoints each unlocks, legacy tier aliases, and how to request the right set for your integration.
- **[Incoming Webhook Security & Posture](WEBHOOK_RECEIVE.md)** – HMAC-SHA256 signature verification, 5-minute replay window, and CIDR allowed origins.
- **[Event Ordering Guarantees](EVENT_ORDERING.md)** – ordering guarantees and guidelines for downstream consumers.
- **[Environment Deployment Guide](DEPLOY.md)** – step-by-step deployment instructions for development, staging, and production environments.


