import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveTimeout, createTimeoutConfig } from './timeouts.js';
import { runWithGlobalTimeout } from '../utils/timeoutContext.js';

describe('timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return the clamped default timeout when no global timeout is set', () => {
    const config = createTimeoutConfig('database', 'DB_QUERY_TIMEOUT');
    const resolved = resolveTimeout('database', config);
    
    // Default database timeout is 2000
    expect(resolved).toBe(2000);
  });

  it('should cap the resolved timeout to the global budget if global budget is smaller', () => {
    runWithGlobalTimeout(1000, () => {
      // 500ms have passed, 500ms remaining
      vi.advanceTimersByTime(500);

      const config = createTimeoutConfig('database', 'DB_QUERY_TIMEOUT');
      const resolved = resolveTimeout('database', config);
      
      // Default is 2000, but global budget has 500ms remaining
      expect(resolved).toBe(500);
    });
  });

  it('should return the clamped service timeout if global budget is larger', () => {
    runWithGlobalTimeout(10000, () => {
      // 1000ms have passed, 9000ms remaining
      vi.advanceTimersByTime(1000);

      const config = createTimeoutConfig('database', 'DB_QUERY_TIMEOUT');
      const resolved = resolveTimeout('database', config);
      
      // Default is 2000, global budget has 9000ms remaining
      // It should return the service default timeout (2000)
      expect(resolved).toBe(2000);
    });
  });

  it('should return 1 when the global budget is already exhausted', () => {
    runWithGlobalTimeout(1000, () => {
      // 1500ms have passed, budget exhausted
      vi.advanceTimersByTime(1500);

      const config = createTimeoutConfig('database', 'DB_QUERY_TIMEOUT');
      const resolved = resolveTimeout('database', config);
      
      // Should fail fast with 1ms
      expect(resolved).toBe(1);
    });
  });
});
