import { job } from '../expiredSessionsSweeper';

describe('expiredSessionsSweeper job', () => {
  it('exports a job with a run function', () => {
    expect(job).toBeTruthy();
    expect(typeof job.run).toBe(Function.type);
  });
});
