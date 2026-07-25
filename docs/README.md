# Documentation Index

This directory contains additional documentation for the Credence Backend.

- **[Blameless Postmortem Template](POSTMORTEM_TEMPLATE.md)** – template for incident reviews with timeline, impact, root cause analysis, and action items.
- **[Replay & Inspection Guide (Operator)](replay_and_inspection.md)** – when to replay failed events and how to inspect prior failures.
- **[Replay‑Safe Handlers & Side‑Effects](REPLAY_SAFE_HANDLERS.md)** – ensuring side‑effects are safe during retries.
- **[Idempotency Guard](IDEMPOTENCY_GUARD.md)** – replay protection for HTTP requests.
- **[Incoming Webhook Security & Posture](WEBHOOK_RECEIVE.md)** – HMAC-SHA256 signature verification, 5-minute replay window, and CIDR allowed origins.
