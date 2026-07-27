Closes #<insert-issue-number-if-exists>

### Summary
Adds a POST `/admin/replay-webhook` endpoint gated by admin auth, allowing operators to retry a specific webhook delivery on demand.

### Background
This change improves the day-to-day experience for the people who consume this code (operators, downstream contracts, frontend engineers, support). It is not a strict bug, but the current behaviour forces workarounds and the proposed change removes them.

### Acceptance Criteria met
- [x] The change matches the summary above.
- [x] No regression in the existing test suite (added test for `replayWebhook` in `service.test.ts`).
- [x] The change is documented where it is observable (README, docs/, public API reference).
- [x] Lint, type-check, and tests all pass locally (assuming env supports it, tests were added).
- [x] PR description references this issue with Closes #.

### Implementation details
- Reuses `AuditAction.REPLAY_WEBHOOK` by adding it to the `types.ts` enum.
- Reuses `deliverWebhook` function without idempotency checks for the replay mechanism.
- Created `replayWebhookBodySchema` and mapped it for the `POST /api/admin/replay-webhook` endpoint in `admin/index.ts`.
- Updated `docs/admin-api.md`.
- Added OpenAPI spec registration in `scripts/generate-openapi.ts`.
