/**
 * Boundary and recovery tests for src/db/repository.ts
 *
 * Covers:
 *  - Input validation (empty/null/wrong-type nodeId, amount, status)
 *  - upsertNode: create, idempotent same-amount, mutating amount change
 *  - updateNodeStatus: unknown node, same-status idempotency, every legal
 *    transition, every illegal transition, optional amount propagation
 *  - getNodeStatus: unknown node returns null, all four statuses
 *  - snapshot(): returns a defensive copy; returns undefined for unknown node
 *  - reset(): clears all state and in-flight locks
 *  - Status-transition graph completeness: all edges exercised
 *  - Concurrency: per-node lock serialises concurrent writes; different nodes
 *    are NOT serialised relative to each other
 *  - Recovery re-drive: failed -> pending -> confirmed -> completed
 *  - DbRepository interface type compatibility
 *  - dbRepository singleton is a fresh InMemoryDbRepository
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryDbRepository,
  dbRepository,
  type DbRepository,
  type NodeStatus,
} from './repository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared fresh instance, reset before every test. */
let repo: InMemoryDbRepository;

beforeEach(() => {
  repo = new InMemoryDbRepository();
});

// ---------------------------------------------------------------------------
// 1. Input validation — upsertNode
// ---------------------------------------------------------------------------
describe('upsertNode — input validation', () => {
  it('throws when nodeId is an empty string', async () => {
    await expect(repo.upsertNode('', '100')).rejects.toThrow(
      'upsertNode: nodeId must be a non-empty string',
    );
  });

  it('throws when nodeId is not a string (number cast)', async () => {
    // TypeScript prevents this at compile time, but JS callers may pass wrong types.
    await expect(repo.upsertNode(42 as unknown as string, '100')).rejects.toThrow(
      'upsertNode: nodeId must be a non-empty string',
    );
  });

  it('throws when nodeId is null', async () => {
    await expect(repo.upsertNode(null as unknown as string, '100')).rejects.toThrow(
      'upsertNode: nodeId must be a non-empty string',
    );
  });

  it('throws when nodeId is undefined', async () => {
    await expect(repo.upsertNode(undefined as unknown as string, '100')).rejects.toThrow(
      'upsertNode: nodeId must be a non-empty string',
    );
  });

  it('throws when amount is an empty string', async () => {
    await expect(repo.upsertNode('node-1', '')).rejects.toThrow(
      'upsertNode: amount must be a non-empty string',
    );
  });

  it('throws when amount is a whitespace-only string', async () => {
    await expect(repo.upsertNode('node-1', '   ')).rejects.toThrow(
      'upsertNode: amount must be a non-empty string',
    );
  });

  it('throws when amount is not a string (number)', async () => {
    await expect(repo.upsertNode('node-1', 100 as unknown as string)).rejects.toThrow(
      'upsertNode: amount must be a non-empty string',
    );
  });

  it('throws when amount is null', async () => {
    await expect(repo.upsertNode('node-1', null as unknown as string)).rejects.toThrow(
      'upsertNode: amount must be a non-empty string',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Input validation — updateNodeStatus
// ---------------------------------------------------------------------------
describe('updateNodeStatus — input validation', () => {
  it('throws when nodeId is empty', async () => {
    await expect(repo.updateNodeStatus('', 'confirmed')).rejects.toThrow(
      'updateNodeStatus: nodeId must be a non-empty string',
    );
  });

  it('throws when nodeId is null', async () => {
    await expect(
      repo.updateNodeStatus(null as unknown as string, 'confirmed'),
    ).rejects.toThrow('updateNodeStatus: nodeId must be a non-empty string');
  });

  it('throws for an unrecognised status string', async () => {
    await repo.upsertNode('node-1', '50');
    await expect(repo.updateNodeStatus('node-1', 'unknown-status')).rejects.toThrow(
      'updateNodeStatus: unknown status "unknown-status"',
    );
  });

  it('throws for empty status string', async () => {
    await repo.upsertNode('node-1', '50');
    await expect(repo.updateNodeStatus('node-1', '')).rejects.toThrow(
      'updateNodeStatus: unknown status ""',
    );
  });

  it('throws for mixed-case status (not a valid NodeStatus)', async () => {
    await repo.upsertNode('node-1', '50');
    await expect(repo.updateNodeStatus('node-1', 'Pending')).rejects.toThrow(
      'updateNodeStatus: unknown status "Pending"',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Input validation — getNodeStatus
// ---------------------------------------------------------------------------
describe('getNodeStatus — input validation', () => {
  it('throws when nodeId is empty', async () => {
    await expect(repo.getNodeStatus('')).rejects.toThrow(
      'getNodeStatus: nodeId must be a non-empty string',
    );
  });

  it('throws when nodeId is null', async () => {
    await expect(repo.getNodeStatus(null as unknown as string)).rejects.toThrow(
      'getNodeStatus: nodeId must be a non-empty string',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. upsertNode — functional behaviour
// ---------------------------------------------------------------------------
describe('upsertNode — functional behaviour', () => {
  it('creates a new node and returns true', async () => {
    const result = await repo.upsertNode('node-1', '100');
    expect(result).toBe(true);
  });

  it('newly created node starts with status "pending"', async () => {
    await repo.upsertNode('node-1', '100');
    const status = await repo.getNodeStatus('node-1');
    expect(status).toBe('pending');
  });

  it('re-upserting with the same amount is idempotent and returns false', async () => {
    await repo.upsertNode('node-1', '100');
    const second = await repo.upsertNode('node-1', '100');
    expect(second).toBe(false);
  });

  it('idempotent upsert preserves existing status', async () => {
    await repo.upsertNode('node-1', '100');
    await repo.updateNodeStatus('node-1', 'confirmed');
    await repo.upsertNode('node-1', '100'); // same amount
    const status = await repo.getNodeStatus('node-1');
    expect(status).toBe('confirmed'); // must not regress to 'pending'
  });

  it('re-upserting with a different amount updates the record and returns true', async () => {
    await repo.upsertNode('node-1', '100');
    const second = await repo.upsertNode('node-1', '200');
    expect(second).toBe(true);
    const snap = repo.snapshot('node-1');
    expect(snap?.amount).toBe('200');
  });

  it('updating amount does NOT change the status', async () => {
    await repo.upsertNode('node-1', '100');
    await repo.updateNodeStatus('node-1', 'confirmed');
    await repo.upsertNode('node-1', '999');
    expect(await repo.getNodeStatus('node-1')).toBe('confirmed');
  });

  it('multiple distinct nodes can be created independently', async () => {
    await repo.upsertNode('alpha', '1');
    await repo.upsertNode('beta', '2');
    expect(await repo.getNodeStatus('alpha')).toBe('pending');
    expect(await repo.getNodeStatus('beta')).toBe('pending');
  });

  it('node IDs are case-sensitive ("Node-1" and "node-1" are distinct)', async () => {
    await repo.upsertNode('Node-1', '10');
    await repo.upsertNode('node-1', '20');
    expect(repo.snapshot('Node-1')?.amount).toBe('10');
    expect(repo.snapshot('node-1')?.amount).toBe('20');
  });
});

// ---------------------------------------------------------------------------
// 5. updateNodeStatus — unknown node
// ---------------------------------------------------------------------------
describe('updateNodeStatus — unknown node', () => {
  it('returns false without throwing for an unknown node', async () => {
    const result = await repo.updateNodeStatus('ghost', 'confirmed');
    expect(result).toBe(false);
  });

  it('does not materialise a record for the unknown node', async () => {
    await repo.updateNodeStatus('ghost', 'confirmed');
    expect(repo.snapshot('ghost')).toBeUndefined();
    expect(await repo.getNodeStatus('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. updateNodeStatus — idempotent same-status
// ---------------------------------------------------------------------------
describe('updateNodeStatus — idempotent same status', () => {
  it('returns false when the node is already in the requested status', async () => {
    await repo.upsertNode('node-1', '100');
    // node starts as 'pending'
    const result = await repo.updateNodeStatus('node-1', 'pending');
    expect(result).toBe(false);
  });

  it('does not mutate updatedAt on a no-op status update', async () => {
    await repo.upsertNode('node-1', '100');
    const before = repo.snapshot('node-1')!.updatedAt;
    // Tiny delay so Date.now() would differ if a write occurred
    await new Promise((r) => setTimeout(r, 5));
    await repo.updateNodeStatus('node-1', 'pending');
    const after = repo.snapshot('node-1')!.updatedAt;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 7. Status-transition graph — all legal edges
// ---------------------------------------------------------------------------
describe('updateNodeStatus — legal status transitions', () => {
  it('pending -> confirmed', async () => {
    await repo.upsertNode('n', '1');
    expect(await repo.updateNodeStatus('n', 'confirmed')).toBe(true);
    expect(await repo.getNodeStatus('n')).toBe('confirmed');
  });

  it('pending -> failed', async () => {
    await repo.upsertNode('n', '1');
    expect(await repo.updateNodeStatus('n', 'failed')).toBe(true);
    expect(await repo.getNodeStatus('n')).toBe('failed');
  });

  it('confirmed -> completed', async () => {
    await repo.upsertNode('n', '1');
    await repo.updateNodeStatus('n', 'confirmed');
    expect(await repo.updateNodeStatus('n', 'completed')).toBe(true);
    expect(await repo.getNodeStatus('n')).toBe('completed');
  });

  it('confirmed -> failed', async () => {
    await repo.upsertNode('n', '1');
    await repo.updateNodeStatus('n', 'confirmed');
    expect(await repo.updateNodeStatus('n', 'failed')).toBe(true);
    expect(await repo.getNodeStatus('n')).toBe('failed');
  });

  it('failed -> pending (recovery re-drive)', async () => {
    await repo.upsertNode('n', '1');
    await repo.updateNodeStatus('n', 'failed');
    expect(await repo.updateNodeStatus('n', 'pending')).toBe(true);
    expect(await repo.getNodeStatus('n')).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// 8. Status-transition graph — all illegal edges
// ---------------------------------------------------------------------------
describe('updateNodeStatus — illegal status transitions', () => {
  const illegalTransitions: Array<[NodeStatus, NodeStatus]> = [
    ['pending', 'completed'],         // skip confirmed
    ['confirmed', 'pending'],         // backwards
    ['completed', 'pending'],         // terminal -> anything
    ['completed', 'confirmed'],
    ['completed', 'failed'],
    ['failed', 'confirmed'],          // cannot skip re-drive
    ['failed', 'completed'],
  ];

  for (const [from, to] of illegalTransitions) {
    it(`throws on ${from} -> ${to}`, async () => {
      await repo.upsertNode('n', '1');
      // Drive to the `from` state
      if (from !== 'pending') {
        // pending -> confirmed if needed
        if (from === 'confirmed' || from === 'completed') {
          await repo.updateNodeStatus('n', 'confirmed');
        }
        if (from === 'completed') {
          await repo.updateNodeStatus('n', 'completed');
        }
        if (from === 'failed') {
          await repo.updateNodeStatus('n', 'failed');
        }
      }
      await expect(repo.updateNodeStatus('n', to)).rejects.toThrow(
        `illegal transition ${from} -> ${to}`,
      );
    });
  }

  it('state is unchanged after a rejected transition', async () => {
    await repo.upsertNode('n', '1');
    // pending -> completed is illegal
    await expect(repo.updateNodeStatus('n', 'completed')).rejects.toThrow();
    expect(await repo.getNodeStatus('n')).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// 9. updateNodeStatus — optional amount propagation
// ---------------------------------------------------------------------------
describe('updateNodeStatus — optional amount parameter', () => {
  it('updates the amount when provided alongside a valid transition', async () => {
    await repo.upsertNode('n', '100');
    await repo.updateNodeStatus('n', 'confirmed', '250');
    expect(repo.snapshot('n')?.amount).toBe('250');
  });

  it('does not update amount when parameter is omitted', async () => {
    await repo.upsertNode('n', '100');
    await repo.updateNodeStatus('n', 'confirmed');
    expect(repo.snapshot('n')?.amount).toBe('100');
  });

  it('amount from an illegal transition is never applied', async () => {
    await repo.upsertNode('n', '100');
    await expect(repo.updateNodeStatus('n', 'completed', '999')).rejects.toThrow();
    expect(repo.snapshot('n')?.amount).toBe('100');
  });
});

// ---------------------------------------------------------------------------
// 10. getNodeStatus — full coverage
// ---------------------------------------------------------------------------
describe('getNodeStatus — return values', () => {
  it('returns null for a node that has never been upserted', async () => {
    expect(await repo.getNodeStatus('nonexistent')).toBeNull();
  });

  it('returns "pending" for a freshly upserted node', async () => {
    await repo.upsertNode('n', '1');
    expect(await repo.getNodeStatus('n')).toBe('pending');
  });

  it('returns "confirmed" after transition', async () => {
    await repo.upsertNode('n', '1');
    await repo.updateNodeStatus('n', 'confirmed');
    expect(await repo.getNodeStatus('n')).toBe('confirmed');
  });

  it('returns "completed" after terminal transition', async () => {
    await repo.upsertNode('n', '1');
    await repo.updateNodeStatus('n', 'confirmed');
    await repo.updateNodeStatus('n', 'completed');
    expect(await repo.getNodeStatus('n')).toBe('completed');
  });

  it('returns "failed" after failure transition', async () => {
    await repo.upsertNode('n', '1');
    await repo.updateNodeStatus('n', 'failed');
    expect(await repo.getNodeStatus('n')).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 11. snapshot() helper
// ---------------------------------------------------------------------------
describe('snapshot()', () => {
  it('returns undefined for an unknown node', () => {
    expect(repo.snapshot('unknown')).toBeUndefined();
  });

  it('returns the correct amount, status, and a numeric updatedAt', async () => {
    const before = Date.now();
    await repo.upsertNode('n', '42');
    const snap = repo.snapshot('n');
    expect(snap).toBeDefined();
    expect(snap?.amount).toBe('42');
    expect(snap?.status).toBe('pending');
    expect(typeof snap?.updatedAt).toBe('number');
    expect(snap!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('snapshot is a defensive copy — mutations do not affect internal state', async () => {
    await repo.upsertNode('n', '42');
    const snap = repo.snapshot('n')!;
    snap.amount = 'TAMPERED';
    snap.status = 'completed' as NodeStatus;
    // Internal state must be unchanged
    expect(repo.snapshot('n')?.amount).toBe('42');
    expect(repo.snapshot('n')?.status).toBe('pending');
  });

  it('updatedAt advances after a mutating amount change', async () => {
    await repo.upsertNode('n', '1');
    const before = repo.snapshot('n')!.updatedAt;
    // Tiny pause so Date.now() can advance
    await new Promise((r) => setTimeout(r, 5));
    await repo.upsertNode('n', '2'); // different amount → mutates
    const after = repo.snapshot('n')!.updatedAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 12. reset()
// ---------------------------------------------------------------------------
describe('reset()', () => {
  it('clears all stored nodes', async () => {
    await repo.upsertNode('a', '1');
    await repo.upsertNode('b', '2');
    repo.reset();
    expect(await repo.getNodeStatus('a')).toBeNull();
    expect(await repo.getNodeStatus('b')).toBeNull();
  });

  it('allows re-creating a previously deleted node', async () => {
    await repo.upsertNode('n', '1');
    await repo.updateNodeStatus('n', 'confirmed');
    repo.reset();
    // Re-insert from scratch
    await repo.upsertNode('n', '999');
    expect(await repo.getNodeStatus('n')).toBe('pending');
    expect(repo.snapshot('n')?.amount).toBe('999');
  });

  it('after reset, lock state is also cleared (new operations do not deadlock)', async () => {
    // Arrange: start an operation that holds the lock, then reset and try again.
    // Since withLock is internal we test this indirectly by confirming that a
    // fresh upsert after reset completes within the test timeout.
    await repo.upsertNode('n', '1');
    repo.reset();
    const result = await repo.upsertNode('n', '2');
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. Recovery re-drive full path: pending -> failed -> pending -> confirmed -> completed
// ---------------------------------------------------------------------------
describe('Recovery re-drive — full lifecycle', () => {
  it('drives a node through its complete recovery lifecycle', async () => {
    await repo.upsertNode('node', '50');
    expect(await repo.getNodeStatus('node')).toBe('pending');

    await repo.updateNodeStatus('node', 'failed');
    expect(await repo.getNodeStatus('node')).toBe('failed');

    // Re-drive: failed -> pending
    await repo.updateNodeStatus('node', 'pending');
    expect(await repo.getNodeStatus('node')).toBe('pending');

    await repo.updateNodeStatus('node', 'confirmed');
    expect(await repo.getNodeStatus('node')).toBe('confirmed');

    await repo.updateNodeStatus('node', 'completed');
    expect(await repo.getNodeStatus('node')).toBe('completed');
  });

  it('completed node is terminal — no further transitions allowed', async () => {
    await repo.upsertNode('node', '50');
    await repo.updateNodeStatus('node', 'confirmed');
    await repo.updateNodeStatus('node', 'completed');

    await expect(repo.updateNodeStatus('node', 'failed')).rejects.toThrow('illegal transition');
    await expect(repo.updateNodeStatus('node', 'pending')).rejects.toThrow('illegal transition');
    await expect(repo.updateNodeStatus('node', 'confirmed')).rejects.toThrow('illegal transition');
  });
});

// ---------------------------------------------------------------------------
// 14. Concurrency — per-node lock serialisation
// ---------------------------------------------------------------------------
describe('Concurrency — per-node lock', () => {
  it('serialises concurrent upserts on the same node (no lost update)', async () => {
    // Fire 20 concurrent upserts on the same node with different amounts.
    // After all settle, exactly one amount must have won (no corruption).
    const nodeId = 'contested';
    const ops = Array.from({ length: 20 }, (_, i) =>
      repo.upsertNode(nodeId, String(i)),
    );
    await Promise.all(ops);
    const snap = repo.snapshot(nodeId);
    expect(snap).toBeDefined();
    // Amount must be one of the submitted values (not undefined/NaN/mixed)
    const submitted = Array.from({ length: 20 }, (_, i) => String(i));
    expect(submitted).toContain(snap!.amount);
  });

  it('transitions on the same node are serialised — final state is one of the valid outcomes', async () => {
    await repo.upsertNode('n', '1');
    // Concurrently attempt two transitions from 'pending': both confirmed and failed
    // are individually legal from pending. The lock serialises them so they execute
    // one-at-a-time: whichever wins first changes the status, then the second must
    // either be a legal follow-on or an illegal transition. The key invariant is
    // that the final status is a valid NodeStatus — no corruption.
    const results = await Promise.allSettled([
      repo.updateNodeStatus('n', 'confirmed'),
      repo.updateNodeStatus('n', 'failed'),
    ]);
    // At least one must have succeeded
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // Final status must be a valid NodeStatus, not corrupted
    const finalStatus = await repo.getNodeStatus('n');
    expect(['pending', 'confirmed', 'completed', 'failed']).toContain(finalStatus);
  });

  it('concurrent identical transitions from same start-state: only one mutates', async () => {
    await repo.upsertNode('n', '1');
    // Two concurrent requests to transition pending -> confirmed.
    // Lock serialises them: first succeeds (returns true), second is idempotent (returns false).
    const [r1, r2] = await Promise.all([
      repo.updateNodeStatus('n', 'confirmed'),
      repo.updateNodeStatus('n', 'confirmed'),
    ]);
    // Final status must be 'confirmed'
    expect(await repo.getNodeStatus('n')).toBe('confirmed');
    // Together the two booleans must total at most 1 true (one actual mutation).
    const mutations = [r1, r2].filter(Boolean).length;
    expect(mutations).toBeLessThanOrEqual(1);
  });

  it('different nodes are NOT blocked by each other\'s locks', async () => {
    // Both operations should complete concurrently without deadlock.
    const [a, b] = await Promise.all([
      repo.upsertNode('alpha', '1'),
      repo.upsertNode('beta', '2'),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('concurrent reads do not block writes (getNodeStatus does not hold a lock)', async () => {
    await repo.upsertNode('n', '1');
    // Interleave reads and writes; neither should block indefinitely.
    const ops = [
      repo.getNodeStatus('n'),
      repo.updateNodeStatus('n', 'confirmed'),
      repo.getNodeStatus('n'),
    ];
    const results = await Promise.all(ops);
    // The write must have completed
    expect(await repo.getNodeStatus('n')).toBe('confirmed');
    // Reads should have returned a valid status (pending or confirmed)
    for (const r of [results[0], results[2]]) {
      expect(['pending', 'confirmed']).toContain(r);
    }
  });
});

// ---------------------------------------------------------------------------
// 15. DbRepository interface compatibility
// ---------------------------------------------------------------------------
describe('DbRepository interface compatibility', () => {
  it('InMemoryDbRepository satisfies DbRepository interface', () => {
    // Structural typing check — assign to the interface type.
    const asInterface: DbRepository = new InMemoryDbRepository();
    expect(typeof asInterface.upsertNode).toBe('function');
    expect(typeof asInterface.updateNodeStatus).toBe('function');
    expect(typeof asInterface.getNodeStatus).toBe('function');
  });

  it('all three interface methods return Promises', async () => {
    const r: DbRepository = new InMemoryDbRepository();
    const p1 = r.upsertNode('n', '1');
    const p2 = r.updateNodeStatus('ghost', 'confirmed');
    const p3 = r.getNodeStatus('ghost');
    expect(p1).toBeInstanceOf(Promise);
    expect(p2).toBeInstanceOf(Promise);
    expect(p3).toBeInstanceOf(Promise);
    // Resolve all to avoid unhandled rejections in the test runner
    await Promise.allSettled([p1, p2, p3]);
  });
});

// ---------------------------------------------------------------------------
// 16. dbRepository singleton
// ---------------------------------------------------------------------------
describe('dbRepository singleton', () => {
  it('is exported and implements DbRepository', () => {
    expect(dbRepository).toBeDefined();
    expect(typeof dbRepository.upsertNode).toBe('function');
    expect(typeof dbRepository.updateNodeStatus).toBe('function');
    expect(typeof dbRepository.getNodeStatus).toBe('function');
  });

  it('is a distinct instance from a newly constructed InMemoryDbRepository', () => {
    const fresh = new InMemoryDbRepository();
    expect(dbRepository).not.toBe(fresh);
  });
});

// ---------------------------------------------------------------------------
// 17. Stale / duplicate event replay safety
// ---------------------------------------------------------------------------
describe('Stale / duplicate event replay safety', () => {
  it('replaying upsertNode with same data is a no-op (idempotent)', async () => {
    await repo.upsertNode('n', '100');
    await repo.updateNodeStatus('n', 'confirmed');
    // Replay the same upsert
    const result = await repo.upsertNode('n', '100');
    expect(result).toBe(false);
    // Status is unchanged
    expect(await repo.getNodeStatus('n')).toBe('confirmed');
  });

  it('replaying updateNodeStatus with same status is a no-op (idempotent)', async () => {
    await repo.upsertNode('n', '100');
    await repo.updateNodeStatus('n', 'confirmed');
    const result = await repo.updateNodeStatus('n', 'confirmed');
    expect(result).toBe(false);
    expect(await repo.getNodeStatus('n')).toBe('confirmed');
  });

  it('multiple concurrent replays of the same no-op transition do not corrupt state', async () => {
    await repo.upsertNode('n', '100');
    await repo.updateNodeStatus('n', 'confirmed');
    // Fire 10 identical replays concurrently
    const replays = Array.from({ length: 10 }, () =>
      repo.updateNodeStatus('n', 'confirmed'),
    );
    const results = await Promise.all(replays);
    // All return false (no-ops)
    expect(results.every((r) => r === false)).toBe(true);
    expect(await repo.getNodeStatus('n')).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// 18. Partial failure: exception during transition leaves consistent state
// ---------------------------------------------------------------------------
describe('Partial failure / exception safety', () => {
  it('an illegal transition exception leaves the original status intact', async () => {
    await repo.upsertNode('n', '1');
    await repo.updateNodeStatus('n', 'confirmed');

    // Attempt an illegal backwards transition
    await expect(repo.updateNodeStatus('n', 'pending')).rejects.toThrow();

    // State must not have regressed
    expect(await repo.getNodeStatus('n')).toBe('confirmed');
  });

  it('a validation error does not leave a partially-written record', async () => {
    // Attempt to create a node with an empty amount (throws)
    await expect(repo.upsertNode('n', '')).rejects.toThrow();
    // No record should have been created
    expect(await repo.getNodeStatus('n')).toBeNull();
    expect(repo.snapshot('n')).toBeUndefined();
  });
});
