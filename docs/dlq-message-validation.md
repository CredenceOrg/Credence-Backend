# DLQ Message Validation & Routing Contract

> Defines how inbound Horizon / queue messages are validated, why they land in the
> dead-letter queue (DLQ), and what operators can do about it.

---

## 1. Reason Codes (`DlqReasonCode`)

Every DLQ entry carries a structured `[REASON_CODE]` prefix in the
`failure_reason` column.  Operators can filter by reason code without parsing
free-form text.

| Code | Trigger Condition | Example Payload | Stored `failure_reason` | Operator Action |
|------|-------------------|-----------------|--------------------------|-----------------|
| `SCHEMA_VALIDATION_FAILED` | Payload does not match Zod schema: missing fields, wrong types, or invalid Stellar account ID. | `{"source_account": "GINVALID", "id": "", "amount": "-5"}` | `[SCHEMA_VALIDATION_FAILED] source_account: Invalid Stellar account ID; amount: Amount must be a non-negative integer string` | Inspect `event_data`. Fix the caller (malformed Horizon op) or patch the schema if a valid payload is rejected. Replay via `POST /api/admin/events/replay/:id`. |
| `UNKNOWN_MESSAGE_TYPE` | The message `type` (or discriminator) has no registered handler. | `{"type": "swap", "id": "op-1"}` | `[UNKNOWN_MESSAGE_TYPE] no handler registered for type: "swap"` | Register a handler or discard the entry (`UPDATE ... SET status = 'skipped'`). |
| `PROCESSING_ERROR` | Payload passed validation but the handler threw at runtime. | `{"source_account": "GA7...", "id": "op-42", "amount": "100"}` | `[PROCESSING_ERROR] DB timeout writing bond record` | Check system logs. Fix the root cause (infra / logic bug) and replay. |
| `MAX_RETRIES_EXCEEDED` | Retry count exceeds the configured limit. | *(same raw payload as the original failing message)* | `[MAX_RETRIES_EXCEEDED] retry_count 5 exceeds limit of 5` | Investigate why the handler cannot succeed. Once resolved, reset `retry_count` or create a fresh replay entry. |

### Schema definition (`src/listeners/messageValidator.ts:12`)

```typescript
export enum DlqReasonCode {
  SCHEMA_VALIDATION_FAILED = 'SCHEMA_VALIDATION_FAILED',
  UNKNOWN_MESSAGE_TYPE     = 'UNKNOWN_MESSAGE_TYPE',
  PROCESSING_ERROR         = 'PROCESSING_ERROR',
  MAX_RETRIES_EXCEEDED     = 'MAX_RETRIES_EXCEEDED',
}
```

---

## 2. `validateAndRoute` Flow

```
rawPayload
    │
    ▼
validateMessage(schema, rawPayload)
    │
    ├── Zod safeParse succeeds ──► { valid: true, data: T }
    │
    └── Zod safeParse fails ──► { valid: false,
                                   reasonCode: SCHEMA_VALIDATION_FAILED,
                                   detail: formatZodErrors(error) }
                                      │
                                      ▼
                              DlqRouter.route(messageType,
                                              rawPayload,
                                              reasonCode,
                                              detail)
                                      │
                                      ▼
                              sink.captureFailure(type, data, reason)
                                      │
                                      ▼
                              INSERT INTO failed_inbound_events
                              (event_type, event_data, failure_reason,
                               replay_token, status)
```

The `validateAndRoute` helper (`src/listeners/messageValidator.ts:148`) wraps
this common pattern:

```typescript
const result = await validateAndRoute(schema, messageType, rawPayload, dlqRouter)
if (!result.valid) return   // already persisted in DLQ
await handle(result.data)
```

### Callers

| Caller | Schema Used | Message Type |
|--------|-------------|--------------|
| `horizonBondEvents.ts:76` | `bondOperationSchema` | `"bond_creation"` |
| `attestationEvents.ts:188` | `attestationEventSchema` | `"attestation"` |
| `horizonWithdrawalEvents.ts:360` | `bondWithdrawalOperationSchema` | `"withdrawal"` |

---

## 3. `DlqRouter` Sink Behaviour

`DlqRouter` (`src/listeners/messageValidator.ts:103`) implements the
`DlqSink` interface which is satisfied by `ReplayService`.

| Behaviour | Detail |
|-----------|--------|
| Reason format | `[REASON_CODE] detail` — a bracketed code followed by a human-readable description. |
| Raw payload | Stored **unmodified** — the original message as received is persisted verbatim. |
| Message type | An event label used to look up the correct `ReplayHandler` on replay (e.g. `"attestation"`, `"withdrawal"`, `"bond_creation"`). |
| Error propagation | If the underlying sink throws (e.g. DB unavailable), the error propagates to the caller. |

---

## 4. `bondOperationSchema` Validation Rules

Defined at `src/listeners/messageValidator.ts:182`:

```typescript
export const bondOperationSchema = z.object({
  source_account: z.string().refine(
    (account) => StrKey.isValidEd25519PublicKey(account)
              || StrKey.isValidMuxedAccount?.(account) ?? false,
    { message: 'Invalid Stellar account ID' }
  ),
  id:            z.string().min(1, 'Operation ID is required'),
  amount:        z.string().refine(
    (amount) => /^\d+$/.test(amount),
    { message: 'Amount must be a non-negative integer string' }
  ),
  duration:      z.union([z.string(), z.null()]).optional(),
})
```

| Field | Type | Rule |
|-------|------|------|
| `source_account` | `string` | Must be a valid Ed25519 public key **or** a valid muxed account (Stellar `M...` address). |
| `id` | `string` | Minimum length 1 (non-empty). |
| `amount` | `string` | Must match `/^\d+$/` — one or more digits (non-negative integer, no decimal separator). |
| `duration` | `string \| null` | Optional; when present must be a string or explicit `null`. |

### `bondWithdrawalOperationSchema` (`messageValidator.ts:208`)

Identical structure to `bondOperationSchema`.

---

## 5. `formatZodErrors` Output Format

Defined at `src/listeners/messageValidator.ts:165`:

```typescript
function formatZodErrors(error: ZodError): string {
  const issues = (error as any).issues ?? (error as any).errors ?? []
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}
```

Output is a semicolon-separated list of `path: message` pairs:

| Condition | Example Output |
|-----------|----------------|
| Root-level type error | `(root): Expected object, received array` |
| Single field failure | `source_account: Invalid Stellar account ID` |
| Multiple field failures | `source_account: Invalid Stellar account ID; amount: Amount must be a non-negative integer string` |
| Nested path | `details.recipient: Required` |

---

## 6. Replaying a Quarantined Message

### `ReplayService` (`src/services/replayService.ts`)

The `ReplayService` class manages the `failed_inbound_events` table and
provides replay capabilities.

### Admin endpoints (`src/routes/admin/index.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/admin/events/failed` | List failed events. Supports `?status=failed&type=attestation` filters. Returns paginated results. |
| `POST` | `/api/admin/events/replay/:id` | Replay a single failed event by ID. Requires `admin:write` role. |

### Replay flow

```
POST /api/admin/events/replay/:id
  │
  ▼
ReplayService.replayEvent(id, adminId, adminEmail, tenantId, ip, requestId)
  │
  ├── Event not found ──► 400 error
  ├── Already replayed ──► { success: false, message: 'Event already replayed' }
  ├── No handler registered ──► throws error
  │
  └── Calls handler.handle(event.eventData)
        │
        ├── Success ──► status → "replayed", retry_count++
        ├── Failure ──► retry_count++, error logged, caller notified
```

### How to replay (manual)

1. **List failed events:**
   ```bash
   curl -H "Authorization: Bearer <admin-token>" \
     "/api/admin/events/failed?status=failed&type=attestation"
   ```
2. **Inspect the entry** — read `event_data`, `failure_reason`, and
   `retry_count` to understand why it failed.
3. **Replay a specific event:**
   ```bash
   curl -X POST -H "Authorization: Bearer <admin-token>" \
     "/api/admin/events/replay/<event-id>"
   ```
4. **Discard (skip)** — update the row directly:
   ```sql
   UPDATE failed_inbound_events SET status = 'skipped' WHERE id = '<event-id>';
   ```

### Registering handlers

Handlers are registered on the `ReplayService` instance at startup via
`registerHandler(eventType, handler)` (`replayService.ts:25`). Each event type
must have exactly one handler for replay to work.

---

## 7. Database Schema

The `failed_inbound_events` table stores all DLQ entries:

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` | Primary key. |
| `event_type` | `text` | Event label (e.g. `"attestation"`, `"withdrawal"`). |
| `event_data` | `jsonb` | Original raw payload (unmodified). |
| `failure_reason` | `text` | `[REASON_CODE] detail` string. |
| `replay_token` | `uuid` | Token generated at capture; used for idempotent replay. |
| `status` | `enum` | `'failed'` \| `'replayed'` \| `'skipped'`. |
| `retry_count` | `integer` | Incremented each replay attempt. Default `0`. |
| `last_retried_at` | `timestamptz` | Timestamp of most recent replay attempt. |
| `created_at` | `timestamptz` | Row creation timestamp. |
| `updated_at` | `timestamptz` | Last update timestamp. |

---

## 8. Sample DLQ Entry

A concrete row from the `failed_inbound_events` table as it would appear to an operator:

| Column | Value |
|--------|-------|
| `id` | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| `event_type` | `bond_creation` |
| `event_data` | `{"source_account": "GABC123", "id": "1234567890", "amount": "-50", "duration": null}` |
| `failure_reason` | `[SCHEMA_VALIDATION_FAILED] amount: Amount must be a non-negative integer string` |
| `replay_token` | `f47ac10b-58cc-4372-a567-0e02b2c3d479` |
| `status` | `failed` |
| `retry_count` | `0` |
| `created_at` | `2026-06-29T10:30:00.000Z` |
| `updated_at` | `2026-06-29T10:30:00.000Z` |

---

## 9. Related Documentation

- [Runbook](./RUNBOOK.md) — general operations runbook.
- [Outbox Quarantine](./outbox-quarantine.md) — outbound message quarantine
  (separate mechanism from the inbound DLQ).
