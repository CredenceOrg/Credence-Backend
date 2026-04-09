import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisProposalStorage } from './redisStorage.js';
import { Proposal, ProposalState } from './multisig.js';

describe('RedisProposalStorage', () => {
  let storage: RedisProposalStorage;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn(),
    };
    storage = new RedisProposalStorage(mockRedis as unknown as Redis);

    // Mock Date.now to freeze time
    vi.spyOn(Date, 'now').mockReturnValue(10000000);
  });

  it('should save a proposal with TTL', async () => {
    const prop: Proposal = {
      id: 'test-1',
      requiredSignatures: 2,
      signers: new Set(['a', 'b']),
      signatures: new Map([['a', 'sig-a']]),
      slashingVotes: new Set(['c']),
      payload: { x: 1 },
      state: ProposalState.PENDING,
      createdAt: 10000000,
      expiresAt: 10000000 + 3600000, // 1 hour later
    };

    await storage.saveProposal(prop);

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    
    // Check key, serialized json syntax, 'EX', and computed TTL (+86400 day buffer)
    const setArgs = mockRedis.set.mock.calls[0];
    expect(setArgs[0]).toBe('governance:proposal:test-1');
    
    // Test the parsing
    const savedJson = JSON.parse(setArgs[1]);
    expect(savedJson.signers).toEqual(['a', 'b']);
    expect(savedJson.signatures).toEqual([['a', 'sig-a']]);
    expect(savedJson.slashingVotes).toEqual(['c']);
    
    expect(setArgs[2]).toBe('EX');
    // TTL should be exactly 3600 + 86400 
    expect(setArgs[3]).toBe(90000);
  });

  it('should get and deserialize a proposal', async () => {
    const serializedData = {
      id: 'test-2',
      requiredSignatures: 1,
      signers: ['d'],
      signatures: [],
      slashingVotes: [],
      payload: null,
      state: ProposalState.APPROVED,
      createdAt: 0,
      expiresAt: 0,
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(serializedData));

    const prop = await storage.getProposal('test-2');
    
    expect(prop).toBeDefined();
    expect(prop?.id).toBe('test-2');
    expect(prop?.signers).toBeInstanceOf(Set);
    expect(prop?.signers.has('d')).toBe(true);
    expect(prop?.signatures).toBeInstanceOf(Map);
    expect(prop?.state).toBe(ProposalState.APPROVED);
    expect(mockRedis.get).toHaveBeenCalledWith('governance:proposal:test-2');
  });

  it('should return undefined if proposal is not found', async () => {
    mockRedis.get.mockResolvedValue(null);
    const prop = await storage.getProposal('test-not-found');
    expect(prop).toBeUndefined();
  });
  
  it('should update a proposal with positive TTL', async () => {
    const prop: Proposal = {
      id: 'test-3',
      requiredSignatures: 2,
      signers: new Set(),
      signatures: new Map(),
      slashingVotes: new Set(),
      payload: { },
      state: ProposalState.PENDING,
      createdAt: 10000000,
      expiresAt: 10000000 + 1000, 
    };

    await storage.updateProposal(prop);

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const setArgs = mockRedis.set.mock.calls[0];
    expect(setArgs[0]).toBe('governance:proposal:test-3');
    expect(setArgs[2]).toBe('EX');
    
    // TTL should be exactly 1 + 86400 = 86401
    expect(setArgs[3]).toBe(86401);
  });

  it('should update a proposal with negative/expired TTL', async () => {
    const prop: Proposal = {
      id: 'test-4',
      requiredSignatures: 2,
      signers: new Set(),
      signatures: new Map(),
      slashingVotes: new Set(),
      payload: { },
      state: ProposalState.PENDING,
      createdAt: 10000000,
      // Create a scenario where TTL < 0 (i.e. long ago)
      expiresAt: 10000000 - 90000000, 
    };

    await storage.updateProposal(prop);

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const setArgs = mockRedis.set.mock.calls[0];
    expect(setArgs[0]).toBe('governance:proposal:test-4');
    expect(setArgs[2]).toBe('EX');
    
    // Should fallback to 3600 minimal TTL
    expect(setArgs[3]).toBe(3600);
  });
});
