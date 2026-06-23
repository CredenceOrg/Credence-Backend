import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Generic OpenAPI-friendly schema for endpoints where contract is not modeled
// with zod in this repository.
const anyObjectSchema = z.object({}).passthrough().openapi('AnyObject');

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

// Bearer token auth used by governance and dispute routes (requireUserAuth)
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'API key sent as `Authorization: Bearer <key>`',
});
const bearerAuth = [{ bearerAuth: [] }];

// Health + JWKS (required by openapi-drift gate)
registry.registerPath({
  method: 'get',
  path: '/api/health',
  summary: 'Health check',
  description: 'Service health status.',
  tags: ['Health'],
  responses: {
    200: {
      description: 'Healthy',
      content: { 'application/json': { schema: z.object({ status: z.string(), service: z.string() }) } },
    },
    503: {
      description: 'Unhealthy',
      content: { 'application/json': { schema: z.object({ status: z.string(), service: z.string() }) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/.well-known/jwks.json',
  summary: 'JWKS',
  description: 'JSON Web Key Set for verifying JWT signatures.',
  tags: ['Security'],
  responses: {
    200: {
      description: 'JWKS returned',
      content: { 'application/json': { schema: z.record(z.any()) } },
    },
  },
});

// Trust paths
registry.registerPath({
  method: 'get',
  path: '/api/trust/{address}',
  summary: 'Get trust score',
  description: 'Returns computed trust score and identity data.',
  tags: ['Trust'],
  request: { params: schemas.trustPathParamsSchema },
  responses: {
    200: { description: 'Trust data', content: { 'application/json': { schema: z.any() } } },
    400: { description: 'Invalid address format', content: { 'application/json': { schema: z.any() } } },
    404: { description: 'No identity record', content: { 'application/json': { schema: z.any() } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/trust',
  summary: 'Trust query (internal)',
  description: 'Trust lookup entrypoint.',
  tags: ['Trust'],
  request: { body: { required: true, content: { 'application/json': { schema: z.any() } } } },
  responses: {
    200: { description: 'Trust data', content: { 'application/json': { schema: z.any() } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: z.any() } } },
  },
});

// Attestations paths
registry.registerPath({
  method: 'get',
  path: '/api/attestations/{address}',
  summary: 'List attestations',
  description: 'Returns attestations for a subject address.',
  tags: ['Attestations'],
  request: { params: schemas.attestationsPathParamsSchema },
  responses: {
    200: { description: 'Attestations', content: { 'application/json': { schema: z.any() } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/attestations',
  summary: 'Create attestation',
  description: 'Creates an attestation and emits events.',
  tags: ['Attestations'],
  request: {
    body: { required: true, content: { 'application/json': { schema: schemas.createAttestationBodySchema } } },
  },
  responses: {
    201: { description: 'Attestation created', content: { 'application/json': { schema: z.any() } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: z.any() } } },
    409: { description: 'Duplicate attestation', content: { 'application/json': { schema: z.any() } } },
  },
});

// Bulk + Imports
registry.registerPath({
  method: 'post',
  path: '/api/bulk',
  summary: 'Bulk operations',
  description: 'Performs bulk operations.',
  tags: ['Bulk'],
  request: { body: { required: true, content: { 'application/json': { schema: z.any() } } } },
  responses: { 200: { description: 'Bulk result', content: { 'application/json': { schema: z.any() } } } },
});

registry.registerPath({
  method: 'post',
  path: '/api/imports',
  summary: 'Imports',
  description: 'Imports data.',
  tags: ['Imports'],
  request: { body: { required: true, content: { 'application/json': { schema: z.any() } } } },
  responses: { 200: { description: 'Import result', content: { 'application/json': { schema: z.any() } } } },
});

// Org policies
registry.registerPath({
  method: 'get',
  path: '/api/orgs/{orgId}/policies',
  summary: 'List policies',
  description: 'Lists policies for an organization.',
  tags: ['Policy'],
  request: { params: schemas.policyOrgPathParamsSchema },
  responses: {
    200: { description: 'Policies', content: { 'application/json': { schema: z.any() } } },
  },
});

// Analytics + Payouts
registry.registerPath({
  method: 'get',
  path: '/api/analytics',
  summary: 'Analytics',
  description: 'Returns analytics summary.',
  tags: ['Analytics'],
  responses: { 200: { description: 'Analytics', content: { 'application/json': { schema: z.any() } } } },
});

registry.registerPath({
  method: 'post',
  path: '/api/payouts',
  summary: 'Create payout',
  description: 'Creates a payout job.',
  tags: ['Payouts'],
  request: { body: { required: true, content: { 'application/json': { schema: schemas.createPayoutSchema } } } },
  responses: { 201: { description: 'Payout created', content: { 'application/json': { schema: z.any() } } } },
});

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

// Governance: slash requests + votes
registry.registerPath({
  method: 'post',
  path: '/api/governance/slash-requests',
  summary: 'Create a slash request',
  description: 'Opens a new slash request awaiting governance votes.',
  tags: ['Governance'],
  security: bearerAuth,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.createSlashRequestBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Slash request created',
      content: { 'application/json': { schema: schemas.slashRequestSchema } },
    },
    400: {
      description: 'Validation error (e.g. threshold < 1, or totalSigners < threshold)',
      content: { 'application/json': { schema: schemas.governanceErrorSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.governanceErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/governance/slash-requests',
  summary: 'List slash requests',
  description: 'Returns a paginated list of slash requests, optionally filtered by status.',
  tags: ['Governance'],
  security: bearerAuth,
  request: { query: schemas.slashRequestsQuerySchema },
  responses: {
    200: {
      description: 'Paginated list of slash requests',
      content: { 'application/json': { schema: schemas.slashRequestsListResponseSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.governanceErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/governance/slash-requests/{id}',
  summary: 'Get a slash request',
  description: 'Returns a single slash request by ID.',
  tags: ['Governance'],
  security: bearerAuth,
  request: { params: schemas.slashRequestPathParamsSchema },
  responses: {
    200: {
      description: 'Slash request found',
      content: { 'application/json': { schema: schemas.slashRequestSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.governanceErrorSchema } },
    },
    404: {
      description: 'No slash request with this ID',
      content: { 'application/json': { schema: schemas.governanceErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/governance/slash-requests/{id}/votes',
  summary: 'Vote on a slash request',
  description: 'Casts an approve/reject vote on a pending slash request.',
  tags: ['Governance'],
  security: bearerAuth,
  request: {
    params: schemas.slashRequestPathParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.submitVoteBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Vote recorded',
      content: { 'application/json': { schema: schemas.voteResultSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.governanceErrorSchema } },
    },
    404: {
      description: 'No slash request with this ID',
      content: { 'application/json': { schema: schemas.governanceErrorSchema } },
    },
    409: {
      description: 'Request already resolved, or voter has already voted',
      content: { 'application/json': { schema: schemas.governanceErrorSchema } },
    },
  },
});

// Disputes: submit, review, resolve, dismiss
registry.registerPath({
  method: 'post',
  path: '/api/disputes',
  summary: 'Submit a dispute',
  description: 'Files a new dispute between two Stellar addresses with supporting evidence.',
  tags: ['Disputes'],
  security: bearerAuth,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.submitDisputeBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Dispute submitted',
      content: { 'application/json': { schema: schemas.disputeSchema } },
    },
    400: {
      description:
        'Validation error (invalid Stellar address, reason too short, missing evidence, or deadline out of range)',
      content: { 'application/json': { schema: schemas.disputeErrorSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.disputeErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/disputes/{id}',
  summary: 'Get a dispute',
  description: 'Returns a single dispute by ID.',
  tags: ['Disputes'],
  security: bearerAuth,
  request: { params: schemas.disputePathParamsSchema },
  responses: {
    200: {
      description: 'Dispute found',
      content: { 'application/json': { schema: schemas.disputeSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.disputeErrorSchema } },
    },
    404: {
      description: 'No dispute with this ID',
      content: { 'application/json': { schema: schemas.disputeErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/disputes/{id}/review',
  summary: 'Mark a dispute under review',
  description: 'Transitions a pending dispute to `under_review`.',
  tags: ['Disputes'],
  security: bearerAuth,
  request: { params: schemas.disputePathParamsSchema },
  responses: {
    200: {
      description: 'Dispute marked under review',
      content: { 'application/json': { schema: schemas.disputeSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.disputeErrorSchema } },
    },
    422: {
      description: 'Invalid state transition (e.g. dispute is not pending)',
      content: { 'application/json': { schema: schemas.disputeTransitionErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/disputes/{id}/resolve',
  summary: 'Resolve a dispute',
  description: 'Transitions a pending or under-review dispute to `resolved` with a resolution note.',
  tags: ['Disputes'],
  security: bearerAuth,
  request: {
    params: schemas.disputePathParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.resolveDisputeBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Dispute resolved',
      content: { 'application/json': { schema: schemas.disputeSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.disputeErrorSchema } },
    },
    422: {
      description: 'Invalid state transition, missing resolution text, or dispute has expired',
      content: { 'application/json': { schema: schemas.disputeTransitionErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/disputes/{id}/dismiss',
  summary: 'Dismiss a dispute',
  description: 'Transitions a pending or under-review dispute to `dismissed` with a reason.',
  tags: ['Disputes'],
  security: bearerAuth,
  request: {
    params: schemas.disputePathParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.dismissDisputeBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Dispute dismissed',
      content: { 'application/json': { schema: schemas.disputeSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.disputeErrorSchema } },
    },
    422: {
      description: 'Invalid state transition or missing dismiss reason',
      content: { 'application/json': { schema: schemas.disputeTransitionErrorSchema } },
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
