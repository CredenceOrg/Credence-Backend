import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisProposalStorage } from './redisStorage.js';
import type { MultisigProposal } from './types.js';

describe('RedisProposalStorage', () => {
  let storage: RedisProposalStorage;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn(),
    };
    storage = new RedisProposalStorage(mockRedis as unknown as Redis);

    vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
  });

  it('should save a proposal with TTL', async () => {
    const prop: MultisigProposal = {
      id: 'test-1',
      requiredSignatures: 2,
      signers: ['a', 'b'],
      action: 'slash_validator',
      signatures: new Map([['a', 'sig-a']]),
      slashingVotes: new Set(['c']),
      payload: { x: 1 },
      status: 'pending',
      createdAt: new Date(10_000_000),
      expiresAt: new Date(10_000_000 + 3_600_000), // 1 hour later
    };

    await storage.saveProposal(prop);

    expect(mockRedis.set).toHaveBeenCalledTimes(1);

    const setArgs = mockRedis.set.mock.calls[0];
    expect(setArgs[0]).toBe('governance:proposal:test-1');

    const savedJson = JSON.parse(setArgs[1]);
    expect(savedJson.signers).toEqual(['a', 'b']);
    expect(savedJson.signatures).toEqual([['a', 'sig-a']]);
    expect(savedJson.slashingVotes).toEqual(['c']);

    expect(setArgs[2]).toBe('EX');
    // TTL: floor(3600000 / 1000) + 86400 = 3600 + 86400 = 90000
    expect(setArgs[3]).toBe(90000);
  });

  it('should get and deserialize a proposal', async () => {
    const serializedData = {
      id: 'test-2',
      requiredSignatures: 1,
      signers: ['d'],
      action: 'distribute_rewards',
      signatures: [],
      slashingVotes: [],
      payload: null,
      status: 'approved',
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(serializedData));

    const prop = await storage.getProposal('test-2');

    expect(prop).toBeDefined();
    expect(prop?.id).toBe('test-2');
    expect(prop?.signers).toEqual(['d']);
    expect(prop?.signatures).toBeInstanceOf(Map);
    expect(prop?.slashingVotes).toBeInstanceOf(Set);
    expect(prop?.status).toBe('approved');
    expect(mockRedis.get).toHaveBeenCalledWith('governance:proposal:test-2');
  });

  it('should return undefined if proposal is not found', async () => {
    mockRedis.get.mockResolvedValue(null);
    const prop = await storage.getProposal('test-not-found');
    expect(prop).toBeUndefined();
  });

  it('should update a proposal with positive TTL', async () => {
    const prop: MultisigProposal = {
      id: 'test-3',
      requiredSignatures: 2,
      signers: [],
      action: 'slash_validator',
      signatures: new Map(),
      slashingVotes: new Set(),
      payload: {},
      status: 'pending',
      createdAt: new Date(10_000_000),
      expiresAt: new Date(10_000_000 + 1_000), // 1 second later
    };

    await storage.updateProposal(prop);

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const setArgs = mockRedis.set.mock.calls[0];
    expect(setArgs[0]).toBe('governance:proposal:test-3');
    expect(setArgs[2]).toBe('EX');
    // TTL: floor(1000 / 1000) + 86400 = 1 + 86400 = 86401
    expect(setArgs[3]).toBe(86401);
  });

  it('should update a proposal with expired TTL and fall back to minimum', async () => {
    const prop: MultisigProposal = {
      id: 'test-4',
      requiredSignatures: 2,
      signers: [],
      action: 'slash_validator',
      signatures: new Map(),
      slashingVotes: new Set(),
      payload: {},
      status: 'pending',
      createdAt: new Date(10_000_000),
      // expiresAt far in the past → ttlSeconds < 0
      expiresAt: new Date(10_000_000 - 90_000_000),
    };

    await storage.updateProposal(prop);

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const setArgs = mockRedis.set.mock.calls[0];
    expect(setArgs[0]).toBe('governance:proposal:test-4');
    expect(setArgs[2]).toBe('EX');
    // Falls back to minimal TTL of 3600
    expect(setArgs[3]).toBe(3600);
  });

  describe('Round-trip serialization', () => {
    it('should preserve all fields in a full round-trip: save → get', async () => {
      const original: MultisigProposal = {
        id: 'roundtrip-1',
        requiredSignatures: 3,
        signers: ['alice', 'bob', 'charlie'],
        action: 'distribute_rewards',
        signatures: new Map([
          ['alice', 'sig-alice-xyz'],
          ['bob', 'sig-bob-abc'],
        ]),
        slashingVotes: new Set(['voter-1', 'voter-2', 'voter-3']),
        payload: { amount: 1000, currency: 'USD' },
        status: 'approved',
        createdAt: new Date(10_000_000),
        expiresAt: new Date(10_000_000 + 7_200_000), // 2 hours later
      };

      // Save the proposal
      await storage.saveProposal(original);

      // Extract what was saved to Redis
      const setArgs = mockRedis.set.mock.calls[0];
      const serializedData = JSON.parse(setArgs[1]);

      // Now simulate getting it back
      mockRedis.get.mockResolvedValue(JSON.stringify(serializedData));

      // Get the proposal and verify all fields
      const retrieved = await storage.getProposal('roundtrip-1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(original.id);
      expect(retrieved?.requiredSignatures).toBe(original.requiredSignatures);
      expect(retrieved?.signers).toEqual(original.signers);
      expect(retrieved?.action).toBe(original.action);
      expect(retrieved?.payload).toEqual(original.payload);
      expect(retrieved?.status).toBe(original.status);

      // Verify signatures Map is preserved
      expect(retrieved?.signatures).toBeInstanceOf(Map);
      expect(retrieved?.signatures.size).toBe(2);
      expect(retrieved?.signatures.get('alice')).toBe('sig-alice-xyz');
      expect(retrieved?.signatures.get('bob')).toBe('sig-bob-abc');

      // Verify slashingVotes Set is preserved
      expect(retrieved?.slashingVotes).toBeInstanceOf(Set);
      expect(retrieved?.slashingVotes.size).toBe(3);
      expect(retrieved?.slashingVotes.has('voter-1')).toBe(true);
      expect(retrieved?.slashingVotes.has('voter-2')).toBe(true);
      expect(retrieved?.slashingVotes.has('voter-3')).toBe(true);

      // Verify Date instances are preserved
      expect(retrieved?.createdAt).toBeInstanceOf(Date);
      expect(retrieved?.expiresAt).toBeInstanceOf(Date);
      expect(retrieved?.createdAt.getTime()).toBe(original.createdAt.getTime());
      expect(retrieved?.expiresAt.getTime()).toBe(original.expiresAt.getTime());
    });

    it('should handle proposals with empty signatures Map', async () => {
      const prop: MultisigProposal = {
        id: 'empty-sigs',
        requiredSignatures: 5,
        signers: ['signer-1', 'signer-2', 'signer-3', 'signer-4', 'signer-5'],
        action: 'slash_validator',
        signatures: new Map(), // Empty
        slashingVotes: new Set(['vote-1']),
        payload: null,
        status: 'pending',
        createdAt: new Date(10_000_000),
        expiresAt: new Date(10_000_000 + 3_600_000),
      };

      await storage.saveProposal(prop);

      const setArgs = mockRedis.set.mock.calls[0];
      const serializedData = JSON.parse(setArgs[1]);
      mockRedis.get.mockResolvedValue(JSON.stringify(serializedData));

      const retrieved = await storage.getProposal('empty-sigs');

      expect(retrieved?.signatures).toBeInstanceOf(Map);
      expect(retrieved?.signatures.size).toBe(0);
    });

    it('should handle proposals with multiple slashing votes', async () => {
      const votes = new Set(Array.from({ length: 50 }, (_, i) => `voter-${i}`));

      const prop: MultisigProposal = {
        id: 'many-votes',
        requiredSignatures: 1,
        signers: ['signer'],
        action: 'slash_validator',
        signatures: new Map([['signer', 'token']]),
        slashingVotes: votes,
        payload: {},
        status: 'pending',
        createdAt: new Date(10_000_000),
        expiresAt: new Date(10_000_000 + 1_800_000),
      };

      await storage.saveProposal(prop);

      const setArgs = mockRedis.set.mock.calls[0];
      const serializedData = JSON.parse(setArgs[1]);
      mockRedis.get.mockResolvedValue(JSON.stringify(serializedData));

      const retrieved = await storage.getProposal('many-votes');

      expect(retrieved?.slashingVotes).toBeInstanceOf(Set);
      expect(retrieved?.slashingVotes.size).toBe(50);
      for (let i = 0; i < 50; i++) {
        expect(retrieved?.slashingVotes.has(`voter-${i}`)).toBe(true);
      }
    });

    it('should correctly preserve TTL buffer when expiry is far in the future', async () => {
      const futureExpiry = new Date(10_000_000 + 30 * 24 * 60 * 60 * 1000); // 30 days

      const prop: MultisigProposal = {
        id: 'future-expiry',
        requiredSignatures: 1,
        signers: ['signer'],
        action: 'distribute_rewards',
        signatures: new Map(),
        slashingVotes: new Set(),
        payload: null,
        status: 'pending',
        createdAt: new Date(10_000_000),
        expiresAt: futureExpiry,
      };

      await storage.saveProposal(prop);

      const setArgs = mockRedis.set.mock.calls[0];
      expect(setArgs[2]).toBe('EX');

      // TTL should be: (futureExpiry - now) / 1000 + 86400
      // = (30 * 86400) + 86400 = 31 * 86400 = 2,678,400 seconds
      const expectedTtl = Math.floor((futureExpiry.getTime() - 10_000_000) / 1000) + 86400;
      expect(setArgs[3]).toBe(expectedTtl);
    });

    it('should maintain key prefix across all operations', async () => {
      const prop: MultisigProposal = {
        id: 'prefix-test',
        requiredSignatures: 1,
        signers: ['signer'],
        action: 'test',
        signatures: new Map(),
        slashingVotes: new Set(),
        payload: null,
        status: 'pending',
        createdAt: new Date(10_000_000),
        expiresAt: new Date(10_000_000 + 3_600_000),
      };

      // Save
      await storage.saveProposal(prop);
      expect(mockRedis.set.mock.calls[0][0]).toMatch(/^governance:proposal:/);

      mockRedis.set.mockClear();

      // Update
      await storage.updateProposal(prop);
      expect(mockRedis.set.mock.calls[0][0]).toMatch(/^governance:proposal:/);

      // Get
      mockRedis.get.mockResolvedValue('{}');
      await storage.getProposal(prop.id);
      expect(mockRedis.get.mock.calls[0][0]).toMatch(/^governance:proposal:/);
    });

    it('should handle update of expired proposal with fallback TTL', async () => {
      const expiredProp: MultisigProposal = {
        id: 'expired-update',
        requiredSignatures: 1,
        signers: ['signer'],
        action: 'slash_validator',
        signatures: new Map(),
        slashingVotes: new Set(),
        payload: null,
        status: 'expired',
        createdAt: new Date(10_000_000),
        // expiresAt far enough in past that (expiresAt - now) / 1000 + 86400 < 0
        expiresAt: new Date(10_000_000 - 100_000_000),
      };

      await storage.updateProposal(expiredProp);

      const setArgs = mockRedis.set.mock.calls[0];
      expect(setArgs[2]).toBe('EX');
      // ttlSeconds = floor(-100000000 / 1000) + 86400 = -100000 + 86400 = -13600
      // Since negative, falls back to 3600
      expect(setArgs[3]).toBe(3600);
    });
  });
});
