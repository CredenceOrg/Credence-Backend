import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

describe('OpenAPI Generation', () => {
  it('should extend Zod with OpenAPI schema mapping', () => {
    const schema = z.string().openapi({ description: 'A test string' });
    expect(schema).toBeDefined();
  });
});
