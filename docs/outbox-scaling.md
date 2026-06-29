# Outbox Publisher Horizontal Scaling: Lease-Aware Sharding

## Overview

To prevent race conditions, lock contention, and duplicate processing when horizontally scaling `OutboxPublisher` instances, the Credence backend implements a hash-modulo sharding mechanism. This ensures that multiple publisher instances can process disjoint subsets of events concurrently with zero contention.

## Sharding Mechanism

The sharding strategy uses an MD5 hash-modulo of the outbox event `id` to determine shard membership. Because event IDs are sequential (`BIGSERIAL`), using a simple modulo directly on `id` could cause hot shards if there is any pattern in sequence generation or ordering. Applying the MD5 hash first ensures uniform distribution of sequential IDs across the available shards.

### Math

For any event with ID $id$, given a total of $N$ shards (where $N = \text{shard\_count}$) and a specific shard index $S$ (where $0 \le S < N$ and $S = \text{shard\_id}$):

1. Convert the ID to a string representation.
2. Calculate the MD5 checksum of the string representation (yielding a 32-character hexadecimal string).
3. Take the first 8 characters (32 bits) of the MD5 hexadecimal checksum.
4. Interpret the 8 hexadecimal characters as a unsigned 32-bit integer.
5. Compute the modulo of the integer with $N$.
6. If the result equals $S$, the event is processed by this shard.

Mathematically, the filter is:
$$\text{ToInt32}(\text{Substring}(\text{MD5}(id), 1, 8)) \pmod N = S$$

### SQL Query Implementation

The sharding filter is applied atomically inside the PostgreSQL `claimEvents` lease acquisition query:

```sql
WHERE ('x'||substr(md5(id::text),1,8))::bit(32)::int % $shard_count = $shard_id
```

This ensures that:
- Each publisher instance only attempts to lock and process events belonging to its assigned slice.
- There is zero row lock contention (using `FOR UPDATE SKIP LOCKED`).
- Poison-pill quarantine guarantees are fully preserved, as sharded lease claiming only filters the event selection and does not alter the validation or error-handling flows.

---

## Deployment & Configuration Examples

When running the outbox publisher, configure each instance by specifying the environment variables or configuration keys for `shardCount` and `shardId`.

### 1 Publisher (Baseline)

A single publisher instance processes 100% of the events.

*   **Instance 1**: `shardCount = 1`, `shardId = 0` (Processes: $X \pmod 1 = 0$, i.e., all events)

### 2 Publishers

Split the outbox load into 2 disjoint slices.

*   **Instance 1**: `shardCount = 2`, `shardId = 0` (Processes ~50% of events)
*   **Instance 2**: `shardCount = 2`, `shardId = 1` (Processes ~50% of events)

### 4 Publishers

Split the outbox load into 4 disjoint slices.

*   **Instance 1**: `shardCount = 4`, `shardId = 0` (Processes ~25% of events)
*   **Instance 2**: `shardCount = 4`, `shardId = 1` (Processes ~25% of events)
*   **Instance 3**: `shardCount = 4`, `shardId = 2` (Processes ~25% of events)
*   **Instance 4**: `shardCount = 4`, `shardId = 3` (Processes ~25% of events)

### 8 Publishers

Split the outbox load into 8 disjoint slices.

*   **Instance 1**: `shardCount = 8`, `shardId = 0` (Processes ~12.5% of events)
*   **Instance 2**: `shardCount = 8`, `shardId = 1` (Processes ~12.5% of events)
*   **Instance 3**: `shardCount = 8`, `shardId = 2` (Processes ~12.5% of events)
*   **Instance 4**: `shardCount = 8`, `shardId = 3` (Processes ~12.5% of events)
*   **Instance 5**: `shardCount = 8`, `shardId = 4` (Processes ~12.5% of events)
*   **Instance 6**: `shardCount = 8`, `shardId = 5` (Processes ~12.5% of events)
*   **Instance 7**: `shardCount = 8`, `shardId = 6` (Processes ~12.5% of events)
*   **Instance 8**: `shardCount = 8`, `shardId = 7` (Processes ~12.5% of events)

---

## Failure Recovery & Resiliency

1.  **Publisher Death**: If an instance dies mid-lease, its claimed events will remain locked in the `processing` state until the lease expires (`lease_expires_at < NOW()`). Any running instance assigned to the same `shardId` will automatically reclaim the expired events in subsequent polling cycles.
2.  **Dynamic Re-sharding**: If the number of publisher instances ($N$) changes during runtime (e.g. from 2 to 4), the hash-modulo slices shift. Any currently processing leases will complete normally under their assigned consumer IDs. Once expired or released, the new slice distribution will apply, ensuring seamless scaling transitions.
