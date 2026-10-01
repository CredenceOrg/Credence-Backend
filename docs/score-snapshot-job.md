# Score Snapshot Job

Scheduled job that periodically computes and persists score snapshots for all active identities.

## Overview

The score snapshot job:
- Fetches all active identities
- Computes trust scores based on bond amount and attestation count
- Persists snapshots to score_history table
- Processes identities in batches for scalability
- Handles errors gracefully with configurable retry behavior

## Score Computation

Default algorithm (60% bond, 40% attestations):

```
score = 0.6 * bondScore + 0.4 * attestationScore

where:
- bondScore    = min(bondAmount / 1000 * 100, 100)
- attestationScore = min(attestationCount / 50 * 100, 100)
```

Inactive identities always receive a score of 0.

### Enforced invariants

`computeScore` (`src/jobs/scoreComputer.ts`) is **total**: for any input it
either returns an integer in `[0, 100]` or throws a `ScoreComputationError`.
It never returns a negative, fractional, `NaN`, or infinite score.

| Invariant | Why it matters |
| --- | --- |
| **Bounded** — both components saturate at 100 and the result is clamped | A slashed bond or a negative attestation count cannot push a score below 0, and no input can push it above 100. |
| **Saturating from both ends** — negative bond/attestation values floor at 0 | A slashed or over-drawn bond is a valid ledger state. Scoring it as 0 keeps a snapshot current instead of leaving the identity without one. |
| **Integer-exact** — components and per-mille weights use `bigint`/integer arithmetic with a single round-half-up | The float-free path cannot flip a score that lands on a rounding boundary, so repeated runs are reproducible. Verified against the float formula for every input in the valid grid. |
| **Overflow-free** — bond amounts are capped before conversion to `Number` | An arbitrarily large `bigint` amount (e.g. 400 digits) cannot become `Infinity` and then `NaN`. |
| **No activeness coercion** — `active` must be a real boolean | A truthy-but-malformed value such as `'false'` or `1` can no longer score an identity that should be at 0. |
| **Inactive short-circuits first** — numeric fields are not validated for an inactive identity | A corrupt bond row on an inactive identity must not stop the job recording the definitive 0, which would otherwise leave a stale score readable as current. |
| **Purity** — the input row is never mutated | Callers can cache and reuse rows safely across batches. |

### Accepted bond amount formats

`bondedAmount` must resolve to an exact integer amount:

| Input | Result |
| --- | --- |
| `'1000'`, `'01000'`, `'+1000'`, `' 1000 '`, `'0x3e8'` | Accepted — every form `BigInt` reads exactly |
| `1000` (safe integer number), `1000n` (bigint) | Accepted |
| `'-1'` | Accepted, floored to 0 |
| `''`, `'   '`, `'1000.5'`, `'1e3'`, `'1_000'`, `'oops'`, `null`, `NaN`, `1.5` | Rejected — coercing these would mis-price the identity |

### Rejection codes

Rejections raise `ScoreComputationError`, which carries a stable `code`, the
`field` at fault, and the sanitised `address`. `ScoreSnapshotJob` counts the
throw, so a corrupt row becomes a visible, countable error rather than a
silently skipped identity.

| Code | Field | Cause |
| --- | --- | --- |
| `INVALID_IDENTITY_DATA` | `data` | Input was not a non-null object |
| `INVALID_ACTIVE_FLAG` | `active` | `active` was present but not a boolean |
| `INVALID_BONDED_AMOUNT` | `bondedAmount` | Amount could not be read as an exact integer |
| `INVALID_ATTESTATION_COUNT` | `attestationCount` | Not a safe integer (`NaN`, `±Infinity`, fractional, non-number, beyond `Number.MAX_SAFE_INTEGER`) |

The message intentionally **omits the offending raw value**. `bondedAmount` and
`attestationCount` originate outside this process, so echoing them verbatim
would let a crafted row inject newlines or arbitrary payloads into logs and
metric labels. Only the code, the field name, and a length-capped, sanitised
address are included — enough to find the row, not enough to be injected by one.

```typescript
import { computeScore, ScoreComputationError } from './jobs/index.js'

try {
  computeScore(row)
} catch (error) {
  if (error instanceof ScoreComputationError) {
    // error.code, error.field, error.address are safe to log and to group by
    console.error(error.code, error.field, error.address)
  } else {
    throw error
  }
}
```

## Usage

### Basic Setup

```typescript
import { createScoreSnapshotJob, computeScore } from './jobs/index.js'

// Create data source
const dataSource: IdentityDataSource = {
  async getActiveAddresses() {
    // Fetch from database
    return ['0xabc...', '0xdef...']
  },
  async getIdentityData(address) {
    // Fetch bond and attestation data
    return {
      address,
      bondedAmount: '1000',
      active: true,
      attestationCount: 25,
    }
  },
}

// Create store
const store: ScoreSnapshotStore = {
  async saveBatch(snapshots) {
    // Save to score_history table
    await db.insert('score_history', snapshots)
  },
}

// Create job
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  batchSize: 100,
  continueOnError: true,
  logger: console.log,
})

// Run once
const result = await job.run()
console.log(`Processed ${result.processed} identities in ${result.duration}ms`)
```

### Scheduled Execution

```typescript
import { createScheduler } from './jobs/index.js'

// Create scheduler (runs every hour)
const scheduler = createScheduler(job, {
  cronExpression: '0 * * * *', // Every hour
  runOnStart: false,
  logger: console.log,
})

// Start scheduler
scheduler.start()

// Stop when needed
scheduler.stop()
```

## Configuration

### Job Options

- `batchSize` (default: 100) - Number of identities to process per batch
- `continueOnError` (default: true) - Continue processing on errors
- `logger` - Function for logging progress and errors

### Scheduler Options

- `cronExpression` (default: '0 * * * *') - Cron schedule
  - `'* * * * *'` - Every minute
  - `'0 * * * *'` - Every hour
  - `'0 0 * * *'` - Every day
- `runOnStart` (default: false) - Run immediately on start
- `logger` - Function for logging

## Supported Cron Patterns

Simplified cron parser supports:
- Every minute: `* * * * *`
- Every hour: `0 * * * *`
- Every day: `0 0 * * *`

For complex patterns, use a full-featured scheduler like node-cron or Bull.

## Job Result

```typescript
interface SnapshotJobResult {
  processed: number  // Identities processed
  saved: number      // Snapshots saved
  errors: number     // Errors encountered
  duration: number   // Duration in ms
  startTime: string  // ISO timestamp
}
```

## Error Handling

### Continue on Error (default)

Logs errors and continues processing remaining identities:

```typescript
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  continueOnError: true,
  logger: (msg) => console.error(msg),
})
```

### Stop on Error

Throws on first error:

```typescript
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  continueOnError: false,
})

try {
  await job.run()
} catch (error) {
  console.error('Job failed:', error)
}
```

With `continueOnError: false` the error propagates unwrapped, so a
`ScoreComputationError` still exposes its `code` and `address` to the operator.
Batches committed before the failure stay committed — a partial run is safe, and
the next run resumes from current data.

### Corrupt data rows

`computeScore` rejects rows it cannot score deterministically (see
[Rejection codes](#rejection-codes)). With the default `continueOnError: true`:

- The offending identity is counted in `result.errors` and gets **no** snapshot.
- Every other identity in the same batch is still scored and saved — one bad
  row cannot take down the batch.
- `result.processed` and `result.saved` exclude the rejected row, so the counts
  stay exact: `saved === processed` and no address is double-counted.

An identity that is rejected keeps whatever score was last persisted, so
repairing the underlying row and letting the next scheduled run pick it up
clears the staleness. Monitor the log lines carrying `[INVALID_BONDED_AMOUNT]`,
`[INVALID_ATTESTATION_COUNT]`, `[INVALID_ACTIVE_FLAG]` and
`[INVALID_IDENTITY_DATA]` to spot a systematically broken query mapper.

## Batch Processing

For large datasets, adjust batch size:

```typescript
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  batchSize: 500, // Process 500 at a time
})
```

Batching reduces memory usage and allows progress tracking.

## Custom Score Algorithm

Provide your own score computation:

```typescript
function customScoreComputer(data: IdentityData): number {
  if (!data.active) return 0
  
  // Custom logic
  const bondScore = Number(BigInt(data.bondedAmount) / 10n)
  const attestationBonus = data.attestationCount * 2
  
  return Math.min(bondScore + attestationBonus, 100)
}

const job = createScoreSnapshotJob(
  dataSource,
  store,
  customScoreComputer
)
```

## Production Deployment

### With Node-Cron

```typescript
import cron from 'node-cron'

cron.schedule('0 * * * *', async () => {
  try {
    const result = await job.run()
    console.log('Job completed:', result)
  } catch (error) {
    console.error('Job failed:', error)
  }
})
```

### With Bull Queue

```typescript
import Queue from 'bull'

const queue = new Queue('score-snapshots', {
  redis: { host: 'localhost', port: 6379 }
})

queue.process(async () => {
  return await job.run()
})

queue.add({}, {
  repeat: { cron: '0 * * * *' }
})
```

## Monitoring

Log job metrics for monitoring:

```typescript
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  logger: (msg) => {
    console.log(msg)
    // Send to monitoring service
    metrics.log(msg)
  },
})
```

Track key metrics:
- Execution duration
- Success/error rates
- Number of identities processed
- Batch processing times
