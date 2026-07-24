# Outbox Quarantine

The outbox publisher quarantines poison-pill events before they enter retry backoff. This keeps malformed rows from consuming retry budget, polluting failure metrics, or blocking throughput for valid events.

## Quarantine Reasons

- `malformed_json`: the stored payload cannot be parsed as a JSON object.
- `schema_invalid`: a queue payload with an existing runtime schema in `src/schemas/queue.ts` fails validation.
- `oversized_payload`: the serialized payload exceeds the publisher size limit, 256 KiB by default.
- `unknown_event_type`: the event type is not registered as a known outbox or queue event.

Quarantined events are moved from `event_outbox` to `outbox_quarantine` immediately. The original retry count is preserved and is not incremented.

## Operator API

List active quarantine rows:

```http
GET /v1/admin/outbox/quarantine?limit=50&reason=schema_invalid
Authorization: Bearer <admin-token>
```

Reinject after fixing the payload:

```http
POST /v1/admin/outbox/quarantine/:id/reinject
X-API-Key: <key with outbox:reinject>
Content-Type: application/json

{
  "payload": {
    "id": "fixed-event-id"
  }
}
```

Reinjection creates a fresh `pending` outbox row with `retry_count = 0`, marks the quarantine row with `reinjected_at` and `reinjected_by`, and writes an audit log entry with action `OUTBOX_REINJECT`.

## Metrics

The publisher increments:

```text
outbox_quarantine_total{reason="<reason>"}
```

Alert on sustained growth by reason. `malformed_json` and `unknown_event_type` usually indicate producer or migration defects; `schema_invalid` means the payload shape needs correction before reinjection.
