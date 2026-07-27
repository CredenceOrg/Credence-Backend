# Pull Request Description

## Overview
Prevents duplicate emissions if the outbox worker crashes mid-batch after publishing events externally but before marking them as "published" in the database.

Closes #689

## Problem
When the `OutboxPublisher` crashes between `publish()` (external delivery) and `markPublished()` (DB update), the event is left in `processing` state. After the consumer lease expires, a new consumer reclaims the event and re-publishes it — causing a **duplicate emission**.

## Solution
Added a `publish_idempotency_key` column to the `event_outbox` table. The publisher atomically sets a key **before** calling `publish()`. When a reclaimed event already has this key, the publisher skips the external publish step and moves straight to `markPublished`.

### Key Changes
1. **`src/db/outbox/types.ts`** — Added `publishIdempotencyKey?: string | null` to `OutboxEvent`
2. **`src/db/outbox/schema.ts`** — Added `publish_idempotency_key TEXT` column to table schema and DO block auto-migration
3. **`src/db/outbox/repository.ts`** — Added `trySetPublishIdempotencyKey()`, `clearPublishIdempotencyKey()` methods; updated `markPublished()`, `markFailed()`, `releaseClaims()` to clear the key; updated `claimEvents()` to return the column
4. **`src/db/outbox/publisher.ts`** — Added idempotency guard in `processEvent()`: checks `event.publishIdempotencyKey` and atomically sets key before publish; centralized key builder in `buildPublishIdempotencyKey()`
5. **`src/db/outbox/publisher.test.ts`** — Added 7 tests covering: key acquisition/rejection, markPublished clears key, markFailed clears key, releaseClaims clears key, reclaimed event mapping, concurrent consumer race prevention
6. **`docs/outbox-scaling.md`** — Documented the idempotency mechanism with a table of scenarios

### Behaviour Matrix

| Scenario | Behaviour |
|---|---|
| Normal publish | Key set → publish → markPublished (key cleared) |
| Crash after publish, before markPublished | On reclaim: key present → skip publish → markPublished |
| Publish fails | Key cleared by markFailed → retry |
| Concurrent consumer race | Only one acquires the key; the second skips |
| Graceful shutdown | releaseClaims clears the key |

### Backward Compatibility
- The new column is nullable and added via the existing DO block migration pattern
- No breaking changes to the public API
- All existing tests continue to pass (19/19)
