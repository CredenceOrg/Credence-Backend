import { describe, it, expect, vi } from 'vitest';
import { VerificationService } from '../../src/services/verificationService.js';

vi.mock('../../src/services/identityService.js', () => ({
  IdentityService: class {
    verifyBulk = vi.fn().mockImplementation((addresses: string[]) => {
      return Promise.resolve({
        results: addresses.map(addr => ({ status: 'verified', address: addr })),
        errors: []
      });
    });
  }
}));

describe('VerificationService', () => {
  it('should process bulk addresses in chunks', async () => {
    const service = new VerificationService();
    const addresses = ['0x1', '0x2', '0x3', '0x4'];
    
    const { results, errors } = await service.verifyBulkChunked(addresses, 2);
    
    expect(results).toHaveLength(4);
    expect(errors).toHaveLength(0);
  });
});
