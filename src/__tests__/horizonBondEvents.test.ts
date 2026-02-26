import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { subscribeBondCreationEvents } from '../listeners/horizonBondEvents';
import { upsertIdentity, upsertBond } from '../services/identityService';

// Explicitly type mockStream and events
let mockStream: (op: any) => Promise<void>;
let events: any[] = [];

describe('Horizon Bond Creation Listener', () => {
  let mockStream: (op: any) => Promise<void>;
  let events: any[] = [];

  beforeAll(() => {
    // Mock Stellar SDK Server
    vi.mock('stellar-sdk', () => ({
      Server: vi.fn(() => ({
        operations: vi.fn(() => ({
          forAsset: vi.fn(() => ({
            cursor: vi.fn(() => ({
              stream: vi.fn(({ onmessage }: { onmessage: (op: any) => Promise<void> }) => {
                mockStream = onmessage;
              })
            }))
          }))
        }))
      }))
    }));
  });

  beforeEach(() => {
    events = [];
    vi.clearAllMocks();
  });

  it('should parse and upsert bond creation events', async () => {
    const op = {
      type: 'create_bond',
      source_account: 'GABC...',
      id: 'bond123',
      amount: '1000',
      duration: '365',
      paging_token: 'token1'
    };
    const upsertIdentityMock = vi.spyOn(await import('../services/identityService'), 'upsertIdentity').mockResolvedValue(true);
    const upsertBondMock = vi.spyOn(await import('../services/identityService'), 'upsertBond').mockResolvedValue(true);

    subscribeBondCreationEvents((event: any) => events.push(event));
    await mockStream(op);

    expect(upsertIdentityMock).toHaveBeenCalledWith({ id: 'GABC...' });
    expect(upsertBondMock).toHaveBeenCalledWith({ id: 'bond123', amount: '1000', duration: '365' });
    expect(events.length).toBe(1);
    expect(events[0].identity.id).toBe('GABC...');
    expect(events[0].bond.id).toBe('bond123');
  });

  it('should ignore non-bond events', async () => {
    const op = { type: 'payment', id: 'other' };
    subscribeBondCreationEvents((event: any) => events.push(event));
    await mockStream(op);
    expect(events.length).toBe(0);
  });

  it('should handle duplicate bond events gracefully', async () => {
    const op = {
      type: 'create_bond',
      source_account: 'GABC...',
      id: 'bond123',
      amount: '1000',
      duration: '365',
      paging_token: 'token1'
    };
    const upsertBondMock = vi.spyOn(await import('../services/identityService'), 'upsertBond').mockResolvedValue(true);
    subscribeBondCreationEvents(() => {});
    await mockStream(op);
    await mockStream(op); // Duplicate
    expect(upsertBondMock).toHaveBeenCalledTimes(2); // Should be idempotent in real DB
  });
});
