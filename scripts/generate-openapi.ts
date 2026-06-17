import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import yaml from 'yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as schemas from '../src/schemas/index.js';

extendZodWithOpenApi(z);
const registry = new OpenAPIRegistry();

// Register reusable component schemas
for (const [key, schema] of Object.entries(schemas)) {
  if (schema instanceof z.ZodType) {
    registry.registerComponent('schemas', key, schema);
  }
}

// Bond paths
registry.registerPath({
  method: 'get',
  path: '/api/bond/{address}',
  summary: 'Get bond status',
  description: 'Returns the current bond status and lifecycle state for a wallet address.',
  tags: ['Bond'],
  request: { params: schemas.bondPathParamsSchema },
  responses: {
    200: {
      description: 'Bond record found',
      content: { 'application/json': { schema: schemas.bondResponseSchema } },
    },
    400: {
      description: 'Invalid address format',
      content: { 'application/json': { schema: schemas.bondErrorSchema } },
    },
    404: {
      description: 'No bond record for this address',
      content: { 'application/json': { schema: schemas.bondErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/bond',
  summary: 'Create or top-up a bond',
  description: 'Creates a new bond or tops up an existing one for the given wallet address.',
  tags: ['Bond'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.createBondBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Bond created or updated',
      content: { 'application/json': { schema: schemas.bondResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: schemas.bondErrorSchema } },
    },
  },
});

const generator = new OpenApiGeneratorV3(registry.definitions);
const document = generator.generateDocument({
  openapi: '3.0.0',
  info: { version: '1.0.0', title: 'Credence API', description: 'Generated OpenAPI documentation from Zod schemas' },
  servers: [{ url: 'https://api.credence.org/v1' }],
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsPath = path.resolve(__dirname, '../docs/openapi.yaml');
fs.mkdirSync(path.dirname(docsPath), { recursive: true });
fs.writeFileSync(docsPath, yaml.stringify(JSON.parse(JSON.stringify(document))), 'utf-8');
console.log('OpenAPI spec generated at docs/openapi.yaml');
