# Atomic Rollback for Horizon Bond Ingestion

## Design Overview

The atomic bond ingestion ensures that state mutations (identity + bond), outbox events, and cursor updates are committed as a single atomic unit. No partial state can survive a failed operation.

## Invariants

1. **Atomicity**: Identity upsert, bond upsert, idempotency marker, and outbox events commit together in one PostgreSQL transaction
2. **Idempotency**: Each Horizon operation ID is processed exactly once, even during replays or reorgs
3. **Cursor Safety**: Cursor advances only after successful atomic commit; failures leave cursor unchanged for safe replay
4. **Cache Consistency**: Cache invalidation deferred to post-commit (not rollback-safe operation)

## Failure Behavior

| Failure Point | Rollback Behavior | Recovery |
|--------------|-------------------|----------|
| Identity upsert fails | Full transaction rollback | Event replayed from previous cursor |
| Bond upsert fails | Full transaction rollback | Event replayed from previous cursor |
| Outbox emission fails | Full transaction rollback | Event replayed from previous cursor |
| Cursor update fails | Cursor unchanged | Event replayed from previous cursor |
| Cache invalidation fails | Logged, non-blocking | Cache may serve stale data until next update |

## Compatibility Impact

- **Breaking Changes**: None - existing `subscribeBondCreationEvents` preserved
- **New API**: `subscribeBondCreationEventsAtomic` and `AtomicBondEventProcessor`
- **Migration**: No database schema changes required

## Operational Limitations

1. **At-least-once delivery**: Duplicate events possible during failover; idempotency prevents duplicate state
2. **Reorg handling**: Horizon cursor may point to reorg'd ledger; replay with idempotency ensures consistency
3. **Transaction duration**: Max 5 seconds (configurable via `maxDurationMs`)
4. **Savepoint limit**: Max 4 savepoints per transaction

## Security Assumptions

1. **RLS policies**: Inherited from existing database transaction manager
2. **Input validation**: Bond operation schema validation before processing
3. **No PII leakage**: Logging uses schema-aware redaction via logger

## Rollback Considerations

- **Automatic rollback**: PostgreSQL transaction ensures atomic rollback on any error
- **Manual intervention**: Not required for partial state; DLQ handles malformed events
- **Recovery**: Replay from last committed cursor restores consistency
