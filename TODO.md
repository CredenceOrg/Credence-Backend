# TODO

- [x] Read authoritative outbox lifecycle states/transitions from code (types/schema/emitter/repository/publisher)
- [x] Read webhook DLQ store implementation for cross-linking (postgresDlqStore)

- [ ] Update `src/db/outbox/README.md` with:
  - [ ] Emit-in-transaction contract
  - [ ] Publisher leasing/claim loop
  - [ ] Retry/backoff logic + exact formula used
  - [ ] DLQ routing on exhaustion (outbox `dead_letter`) and cross-link webhook `webhook_dlq`
  - [ ] Mermaid sequence diagram (emit → claim/lease → publish → ack/markPublished OR markFailed → dead_letter)
  - [ ] State diagram with exact status names
  - [ ] Metrics list with exact metric names/labels
- [ ] Run `npm run lint` and `npm run build`

