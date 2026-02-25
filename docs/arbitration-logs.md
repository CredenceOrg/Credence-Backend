# Governance Service – Arbitration Logs

> **Module path:** `src/services/governance/arbitrationLogs.ts`

## Overview

The Arbitration Logs module provides an **immutable audit trail** for the full
dispute lifecycle within the Credence governance system. Every significant
governance event – dispute opening, evidence submission, arbitrator votes,
resolution, and escalation – is captured as a frozen, append-only log entry.

Once written, entries **cannot be modified or deleted**, ensuring a
tamper-evident record suitable for on-chain governance and compliance.

## Architecture

```
┌─────────────┐      ┌──────────────────────────┐      ┌────────────────────────────┐
│  Express     │─────▶│  ArbitrationLogService    │─────▶│  ArbitrationLogRepository  │
│  Routes      │      │  (business logic)         │      │  (append-only store)       │
└─────────────┘      └──────────────────────────┘      └────────────────────────────┘
```

| Layer        | File                                             | Responsibility                           |
|-------------|--------------------------------------------------|------------------------------------------|
| **Types**    | `src/types/governance.ts`                        | Enums, interfaces, payload maps          |
| **Repo**     | `src/repositories/arbitrationLogRepository.ts`   | Append-only in-memory store, queries     |
| **Service**  | `src/services/governance/arbitrationLogs.ts`     | Lifecycle methods, sequence numbering    |
| **Routes**   | `src/routes/governance.ts`                       | REST endpoints under `/api/governance/`  |

## Data Model

### `ArbitrationLogEntry`

| Field            | Type                    | Description                                      |
|-----------------|-------------------------|--------------------------------------------------|
| `id`            | `string` (UUID v4)       | Unique identifier                                |
| `disputeId`     | `string`                 | The dispute this entry belongs to                |
| `eventType`     | `ArbitrationEventType`   | Discriminated event type enum                    |
| `payload`       | *(varies by eventType)*  | Event-specific data                              |
| `timestamp`     | `string` (ISO-8601)      | When the event was recorded                      |
| `actor`         | `string`                 | Identity that triggered the event                |
| `sequenceNumber`| `number`                 | Monotonically increasing index within the dispute|

### Event Types

| Enum Value             | Payload Interface           | Description            |
|------------------------|-----------------------------|------------------------|
| `DISPUTE_OPENED`       | `DisputeOpenedPayload`      | New dispute created    |
| `EVIDENCE_SUBMITTED`   | `EvidenceSubmittedPayload`  | Evidence added         |
| `VOTE_CAST`            | `VoteCastPayload`           | Arbitrator vote        |
| `DISPUTE_RESOLVED`     | `DisputeResolvedPayload`    | Final outcome recorded |
| `DISPUTE_ESCALATED`    | `DisputeEscalatedPayload`   | Escalated to authority |

## API Endpoints

All endpoints are mounted at **`/api/governance/arbitration-logs`**.

### Write Operations

| Method | Path                                  | Body                                | Description            |
|--------|---------------------------------------|-------------------------------------|------------------------|
| POST   | `/disputes/:disputeId/open`           | `DisputeOpenedPayload + actor?`     | Open a dispute         |
| POST   | `/disputes/:disputeId/evidence`       | `EvidenceSubmittedPayload + actor?`  | Submit evidence        |
| POST   | `/disputes/:disputeId/vote`           | `VoteCastPayload + actor?`          | Cast an arbitrator vote|
| POST   | `/disputes/:disputeId/resolve`        | `DisputeResolvedPayload + actor`    | Record resolution      |
| POST   | `/disputes/:disputeId/escalate`       | `DisputeEscalatedPayload + actor`   | Escalate dispute       |

### Read Operations

| Method | Path                                  | Query Params                                                | Description             |
|--------|---------------------------------------|-------------------------------------------------------------|-------------------------|
| GET    | `/disputes/:disputeId/timeline`       | —                                                           | Full dispute timeline   |
| GET    | `/entries/:id`                        | —                                                           | Single entry by ID      |
| GET    | `/entries`                            | `disputeId`, `identity`, `eventTypes`, `from`, `to`, `limit`, `offset` | Query with filters |

### Example: Full Lifecycle

```bash
# 1. Open a dispute
curl -X POST http://localhost:3000/api/governance/arbitration-logs/disputes/d-1/open \
  -H 'Content-Type: application/json' \
  -d '{"claimant":"0xAAA","respondent":"0xBBB","reason":"False attestation"}'

# 2. Submit evidence
curl -X POST http://localhost:3000/api/governance/arbitration-logs/disputes/d-1/evidence \
  -H 'Content-Type: application/json' \
  -d '{"submittedBy":"0xBBB","evidenceRefs":[{"label":"doc","uri":"ipfs://Qm1"}]}'

# 3. Cast a vote
curl -X POST http://localhost:3000/api/governance/arbitration-logs/disputes/d-1/vote \
  -H 'Content-Type: application/json' \
  -d '{"voter":"0xArb","direction":"FOR_CLAIMANT","justification":"Evidence is clear"}'

# 4. Resolve
curl -X POST http://localhost:3000/api/governance/arbitration-logs/disputes/d-1/resolve \
  -H 'Content-Type: application/json' \
  -d '{"outcome":"CLAIMANT_WINS","summary":"Majority in favour","actor":"0xPanel"}'

# 5. Query timeline
curl http://localhost:3000/api/governance/arbitration-logs/disputes/d-1/timeline

# 6. Query by identity + time range
curl 'http://localhost:3000/api/governance/arbitration-logs/entries?identity=0xAAA&from=2026-01-01'
```

## Service API (Programmatic)

```typescript
import { ArbitrationLogService } from './services/governance/arbitrationLogs.js';

const service = new ArbitrationLogService();

// Log events
service.logDisputeOpened('d-1', { claimant, respondent, reason }, actor);
service.logEvidenceSubmitted('d-1', { submittedBy, evidenceRefs }, actor);
service.logVoteCast('d-1', { voter, direction, justification }, actor);
service.logDisputeResolved('d-1', { outcome, summary, voteTally }, actor);
service.logDisputeEscalated('d-1', { reason, escalatedTo }, actor);

// Query
service.getEntryById(id);
service.getDisputeTimeline('d-1');
service.query({ disputeId, identity, eventTypes, from, to, limit, offset });
service.totalEntries;
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

Test suites:

| Suite                                    | Covers                                          |
|------------------------------------------|--------------------------------------------------|
| `tests/repositories/arbitrationLogRepository.test.ts` | Append, immutability, queries, pagination |
| `tests/services/governance/arbitrationLogs.test.ts`   | All lifecycle methods, timeline, query    |
| `tests/routes/governance.test.ts`                     | All REST endpoints, status codes, filters |

## Design Decisions

1. **Append-only / immutable** – entries are `Object.freeze()`d immediately;
   the repository exposes no update or delete methods.
2. **Sequence numbers** – each dispute maintains an independent monotonic
   counter for deterministic ordering within a dispute timeline.
3. **In-memory store** – the current implementation uses an in-memory array.
   Swap `ArbitrationLogRepository` for a database-backed implementation
   when persistence is required (the service layer stays unchanged thanks to
   dependency injection via the constructor).
4. **Typed payloads** – the `ArbitrationPayloadMap` ensures that each event
   type is paired with the correct payload shape at compile time.
