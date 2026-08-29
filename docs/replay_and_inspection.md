# Replay & Inspection Guide (Operator)

## Purpose
This guide explains **when to replay** failed inbound events and **how to inspect prior failures** in the Credence Backend. It targets operators who need to troubleshoot live incidents without modifying code.

## When to Replay
- **At‑least‑once delivery**: Queue or Horizon events that failed (e.g., network timeout, transient DB error) are captured for replay.
- **Manual operator request**: When an alert indicates a failed event, operators can trigger a replay via the Admin API.
- **Automated retry**: The system automatically retries events after a back‑off; operators may intervene if retries exceed the configured limit.

## How to Inspect Prior Failures
1. **View the failure ledger**:
   ```bash
   curl -X GET http://localhost:3000/api/admin/failure‑ledger
   ```
   The response contains a list of events with `id`, `type`, `timestamp`, and `error` details.
2. **Check logs** (structured logging example):
   ```bash
   docker compose logs -f backend | grep "failed_event_id"
   ```
   Look for `eventId` and `errorMessage` fields.
3. **Database audit** (if persisted):
   ```sql
   SELECT * FROM failed_events WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20;
   ```

## Replaying an Event
### API endpoint
```http
POST /api/admin/replay/:eventId
```
- **Path parameter**: `eventId` – the UUID of the failed event.
- **Response**:
  ```json
  {"status":"queued","eventId":"<id>"}
  ```
- **Idempotency**: Include `Idempotency-Key` header to avoid duplicate replays.

### CLI example (using `credence-cli` if available)
```bash
credence replay --event-id <event-id>
```

## Verifying the Replay
1. Query the event status:
   ```bash
   curl http://localhost:3000/api/admin/event-status/<event-id>
   ```
2. Ensure side‑effects are **replay‑safe** (see `docs/REPLAY_SAFE_HANDLERS.md`).
3. Confirm no duplicate notifications were sent (check webhook logs).

## Common Pitfalls
- **Missing idempotency**: Replays without `Idempotency-Key` may cause duplicate external calls.
- **Stale data**: If the underlying record changed since the original failure, the replay may be rejected – check for version conflicts.
- **Resource limits**: High replay volumes can saturate DB/Redis; monitor metrics in `docs/OBSERVABILITY.md`.

## Related Documentation
- **[Replay‑Safe Handlers & Side‑Effects](docs/REPLAY_SAFE_HANDLERS.md)** – ensures side‑effects are safe during retries.
- **[Operational Guides in README](README.md)** – entry point for operators.
