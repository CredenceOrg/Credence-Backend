# Pull Request Description

## Overview
This PR introduces the **Replay & Inspection Guide** (`docs/replay_and_inspection.md`) for operators running the Credence Backend. This guide outlines the exact scenarios under which failed inbound events should be replayed and details how to inspect prior failures using logs, the administrative API, and database tools.

## Key Additions & Changes
1. **New Guide** (`docs/replay_and_inspection.md`):
   - **When to Replay:** Clearly explains scenarios such as transient database connectivity issues, network timeouts, or manual overrides.
   - **How to Inspect:** Step-by-step instructions on querying the failure ledger (`GET /api/admin/failure-ledger`), searching logs for specific `eventId` occurrences, and executing target database queries on `failed_events`.
   - **How to Replay:** Concrete documentation of the `POST /api/admin/replay/:eventId` API endpoint (including the use of the `Idempotency-Key` header) and CLI examples.
   - **Verification:** Post-replay validation steps to verify the event state transitions and confirm that no duplicate side effects were dispatched.
   - **Common Pitfalls:** Tips on preventing duplicate side effects and handling stale state conflicts during replays.
   
2. **Discoverability & Link Upgrades**:
   - Cross-linked the new guide directly under the "Replay-Safe Handlers & Side-Effects" section in the root [README.md](README.md).
   - Created [docs/README.md](docs/README.md) as a top-level documentation index and referenced the new operator guide to prevent orphan documents.

## Out of Scope
- No modifications were made to the codebase itself (such as changes to `ReplayService` or `replaySafeHandler`), maintaining the integrity of adjacent modules.

Closes #
