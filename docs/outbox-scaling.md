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

---

## Worker Leadership Lease (Advisory Locks)

When running multiple replicas behind a load balancer, you may want **only one** instance to run the outbox loop at a time, while the others remain in standby. This avoids duplicate processing and simplifies operational reasoning.

The worker leadership lease uses **Postgres session-level advisory locks** (`pg_advisory_lock` / `pg_advisory_try_lock`) to elect a single leader.

### How It Works

```
Instance A                    Instance B                    Postgres
    │                             │                             │
    ├── pg_advisory_lock(5381) ──┼────────────────────────────▶│
    │◀── true (leader) ──────────┼─────────────────────────────┤
    │   starts outbox loop       │                             │
    │                            ├── pg_advisory_lock(5381) ──▶│
    │                            │◀── blocks (standby) ────────┤
    │   [connection dies]        │                             │
    │                            │◀── lock released (session) ─┤
    │                            │   now acquires lock         │
    │                            │   starts outbox loop        │
```

1. On start, each instance checks out a dedicated connection and calls `pg_advisory_lock(5381)`.
2. The first instance to acquire the lock becomes **leader** and starts the outbox publisher loop.
3. Other instances block on the same lock key and stay in **standby** mode.
4. If the leader's Postgres connection dies (crash, network partition, DB restart), the session is destroyed and the lock is automatically released.
5. A standby instance's blocked `pg_advisory_lock` call returns, it becomes the new leader, and starts the outbox loop.
6. A heartbeat timer on the leader verifies the connection is alive; if it fails, the instance reverts to standby and re-enters the acquisition race.

### Configuration

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `OUTBOX_LEADER_LEASE_ENABLED` | `false` | Enable leader election via advisory locks |
| `OUTBOX_LEADER_LEASE_RETRY_MS` | `5000` | Standby retry interval (ms) |
| `OUTBOX_LEADER_LEASE_HEARTBEAT_MS` | `10000` | Leader heartbeat interval (ms) |

### Enabling

Set `OUTBOX_LEADER_LEASE_ENABLED=true` in your environment. No database migrations are required — advisory locks are a built-in Postgres feature that uses no tables.

### Observability

Two Prometheus counters are emitted:

- `outbox_leader_acquired_total` — incremented each time this instance acquires leadership.
- `outbox_leader_lost_total` — incremented each time this instance loses leadership.

### Combining with Sharding

The leadership lease is independent of sharding. If you enable both, only the leader instance runs a publisher, and it processes events from all shards. If you need horizontal scaling with leadership, consider a **leader-per-shard** pattern where each shard assignment gets its own advisory lock key.
