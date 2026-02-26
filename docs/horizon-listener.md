# Horizon Bond Creation Listener

This module listens for bond creation events from Stellar/Horizon and syncs identity and bond state to the database.

## Features
- Subscribes to Horizon for bond creation events
- Parses event payload (identity, amount, duration, etc.)
- Upserts identity and bond records in PostgreSQL
- Handles reconnection and backfill
- Comprehensive tests with mocked Horizon

## Usage

```typescript
import { subscribeBondCreationEvents } from '../src/listeners/horizonBondEvents';

subscribeBondCreationEvents((event) => {
  // Handle bond creation event
  console.log(event);
});
```

## Event Payload Example
```
{
  identity: {
    id: 'GABC...',
    // ...other fields
  },
  bond: {
    id: 'bond123',
    amount: '1000',
    duration: '365',
    // ...other fields
  }
}
```

## Testing
- Tests are located in `src/__tests__/horizonBondEvents.test.ts`
- Run tests with `npm test` or `npx jest`
- Mocked Horizon stream covers event parsing, DB upsert, duplicate handling

## JSDoc
- All functions are documented with JSDoc comments in `src/listeners/horizonBondEvents.ts`

## Requirements
- Minimum 95% test coverage
- Clear documentation

## Backfill & Reconnection
- Listener automatically reconnects on errors
- Backfill logic can be extended to fetch missed events

---
For further details, see the code and tests.
