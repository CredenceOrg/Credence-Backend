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
});
