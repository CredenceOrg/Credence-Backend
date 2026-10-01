// src/jobs/constants.test.ts
import { expect } from 'chai';
import { validateWorkerLocks, resolveWorkerName, WORKER_LOCKS, WorkerLockKey } from './constants.js';

describe('Worker Locks Constants', () => {
  it('should validate existing worker locks without throwing', () => {
    expect(() => validateWorkerLocks()).to.not.throw();
  });

  it('should resolve known lock key to friendly name', () => {
    const key = Object.keys(WORKER_LOCKS)[0] as WorkerLockKey;
    const name = WORKER_LOCKS[key];
    expect(resolveWorkerName(key)).to.equal(name);
  });

  it('should return the key itself for unknown lock keys', () => {
    const unknownKey = 'cron:unknown-task';
    expect(resolveWorkerName(unknownKey)).to.equal(unknownKey);
  });
});
