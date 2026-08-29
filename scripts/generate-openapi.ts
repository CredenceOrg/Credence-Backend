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
      content: { 'application/json': { schema: z.object({ status: z.string(), service: z.string(), version: z.object({ gitSha: z.string(), buildTimestamp: z.string(), nodeVersion: z.string() }) }) } },
    },
    503: {
      description: 'Unhealthy',
      content: { 'application/json': { schema: z.object({ status: z.string(), service: z.string(), version: z.object({ gitSha: z.string(), buildTimestamp: z.string(), nodeVersion: z.string() }) }) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/version',
  summary: 'Build version',
  description:
    "Returns the running build's git SHA, build timestamp, and Node version, so support/on-call can confirm which build is deployed.",
  tags: ['Health'],
  responses: {
    200: {
      description: 'Version metadata',
      content: { 'application/json': { schema: schemas.versionResponseSchema } },
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

// Fault-injection (dev-only, behind DEV_MODE flag)
registry.registerPath({
  method: 'post',
  path: '/api/dev/fault-injection',
  summary: 'Fault injection',
  description:
    'Returns a configurable HTTP error (default 500) with a structured JSON body. ' +
    'Only available when DEV_MODE is enabled (404 otherwise). Intended for chaos / retry testing.',
  tags: ['Dev'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.faultInjectionRequestSchema } },
    },
  },
  responses: {
    200: { description: 'Simulated fault response', content: { 'application/json': { schema: schemas.faultInjectionResponseSchema } } },
    400: { description: 'Validation error (invalid statusCode or message too long)', content: { 'application/json': { schema: z.object({ error: z.string(), details: z.array(z.any()) }) } } },
    404: { description: 'DEV_MODE is disabled', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
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

// Wallet paths
registry.registerPath({
  method: 'post',
  path: '/api/wallets',
  summary: 'Create a wallet',
  description: 'Creates a new wallet with an optional initial balance.',
  tags: ['Wallets'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.createWalletBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Wallet created',
      content: { 'application/json': { schema: schemas.walletSchema } },
    },
    409: {
      description: 'A wallet with this address already exists',
      content: { 'application/json': { schema: schemas.walletErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/wallets/{id}/debit',
  summary: 'Debit a wallet',
  description: 'Atomically debits the specified amount from a wallet balance. Fails if the balance would go negative.',
  tags: ['Wallets'],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.walletDebitBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Debit successful',
      content: { 'application/json': { schema: schemas.walletDebitResponseSchema } },
    },
    404: {
      description: 'Wallet not found',
      content: { 'application/json': { schema: schemas.walletErrorSchema } },
    },
    422: {
      description: 'Insufficient balance',
      content: { 'application/json': { schema: schemas.walletErrorSchema } },
    },
  },
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

// Feature Flags Admin API
// All routes require Bearer auth + admin role.

registry.registerPath({
  method: 'get',
  path: '/api/admin/feature-flags',
  summary: 'List feature flags',
  description:
    'Returns all feature flags with their effective state (override, per-tenant rollout, global rollout, or default) for the caller\'s tenant.',
  tags: ['Feature Flags'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'Feature flag list',
      content: { 'application/json': { schema: schemas.flagListResponseSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/feature-flags',
  summary: 'Create a feature flag',
  description: 'Creates a new feature flag. The flag key must be unique across the system.',
  tags: ['Feature Flags'],
  security: bearerAuth,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.createFlagBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Feature flag created',
      content: { 'application/json': { schema: schemas.flagResponseEnvelopeSchema } },
    },
    400: {
      description: 'Validation error (e.g. invalid key format, rolloutPercent out of range)',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/admin/feature-flags/{key}',
  summary: 'Update a feature flag',
  description: 'Updates one or more fields on an existing feature flag. All fields are optional.',
  tags: ['Feature Flags'],
  security: bearerAuth,
  request: {
    params: schemas.flagKeyParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.updateFlagBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Feature flag updated',
      content: { 'application/json': { schema: schemas.flagResponseEnvelopeSchema } },
    },
    400: {
      description: 'Validation error or no fields provided',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
    404: {
      description: 'Feature flag not found',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/feature-flags/{key}/overrides',
  summary: 'Set a per-tenant boolean override',
  description:
    'Creates or updates a boolean on/off override for a specific tenant. ' +
    'A boolean override always takes the highest precedence, superseding any per-tenant rollout or global rollout.',
  tags: ['Feature Flags'],
  security: bearerAuth,
  request: {
    params: schemas.flagKeyParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.setOverrideBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Override created or updated',
      content: { 'application/json': { schema: schemas.overrideResponseEnvelopeSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
    404: {
      description: 'Feature flag not found',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/feature-flags/{key}/overrides/{tenantId}',
  summary: 'Remove a per-tenant boolean override',
  description:
    'Removes a boolean override for a specific tenant. ' +
    'After removal the tenant falls back to per-tenant rollout (if configured), global rollout, or defaultEnabled.',
  tags: ['Feature Flags'],
  security: bearerAuth,
  request: { params: schemas.flagKeyTenantParamsSchema },
  responses: {
    200: {
      description: 'Override removed',
      content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
    404: {
      description: 'Override not found',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/feature-flags/{key}/tenant-rollouts',
  summary: 'Set a per-tenant rollout percentage',
  description:
    'Creates or updates a per-tenant rollout percentage for a flag. ' +
    'Allows different tenants to receive the flag at different rollout speeds. ' +
    'Sticky user-id bucketing (SHA-256 hash of flagKey:userId) still applies within the tenant\'s percentage window. ' +
    'A boolean override (if present) always takes precedence over this setting.',
  tags: ['Feature Flags'],
  security: bearerAuth,
  request: {
    params: schemas.flagKeyParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.setTenantRolloutBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Per-tenant rollout created or updated',
      content: { 'application/json': { schema: schemas.tenantRolloutResponseEnvelopeSchema } },
    },
    400: {
      description: 'Validation error (e.g. rolloutPercent out of range)',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
    404: {
      description: 'Feature flag not found',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/feature-flags/{key}/tenant-rollouts/{tenantId}',
  summary: 'Remove a per-tenant rollout percentage',
  description:
    'Removes a per-tenant rollout percentage. ' +
    'After removal the tenant falls back to the global rollout percent (or defaultEnabled if that is also 0).',
  tags: ['Feature Flags'],
  security: bearerAuth,
  request: { params: schemas.flagKeyTenantParamsSchema },
  responses: {
    200: {
      description: 'Per-tenant rollout removed',
      content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: schemas.flagErrorResponseSchema } },
    },
  },
});

// Admin Migrations API
registry.registerPath({
  method: 'get',
  path: '/api/admin/migrations/dry-run',
  summary: 'Migration dry-run (GET)',
  description: 'Previews the SQL statements that would be executed by the next pending database migration up.',
  tags: ['Admin Migrations'],
  security: bearerAuth,
  request: {
    query: schemas.migrationsDryRunQuerySchema,
  },
  responses: {
    200: {
      description: 'Dry run completed successfully with pending SQL statements',
      content: { 'application/json': { schema: schemas.migrationsDryRunResponseSchema } },
    },
    400: {
      description: 'Migration dry run failed',
      content: { 'application/json': { schema: z.object({ success: z.literal(false), error: z.string(), message: z.string() }) } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
    },
    403: {
      description: 'Forbidden - Requires admin role',
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/migrations/dry-run',
  summary: 'Migration dry-run (POST)',
  description: 'Previews the SQL statements that would be executed by the next pending database migration up.',
  tags: ['Admin Migrations'],
  security: bearerAuth,
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: schemas.migrationsDryRunBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Dry run completed successfully with pending SQL statements',
      content: { 'application/json': { schema: schemas.migrationsDryRunResponseSchema } },
    },
    400: {
      description: 'Migration dry run failed',
      content: { 'application/json': { schema: z.object({ success: z.literal(false), error: z.string(), message: z.string() }) } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
    },
    403: {
      description: 'Forbidden - Requires admin role',
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
    },
  },
});

// Admin Replay Event API
registry.registerPath({
  method: 'post',
  path: '/api/admin/replay-event',
  summary: 'Replay a failed inbound event',
  description:
    'Replays a specific failed inbound event by id (passed in body) to its registered handler pipeline. Audit-logged via ReplayService.replayEvent.',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.replayEventBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Event replayed successfully',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean().openapi({ example: true }),
            message: z.string().openapi({ example: 'Event successfully replayed' }),
          }),
        },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
    },
    404: {
      description: 'Event not found',
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
    },
  },
});

// Admin System API
registry.registerPath({
  method: 'get',
  path: '/api/admin/system/backup-status',
  summary: 'System Backup Status',
  description: 'Returns the status of the continuous WAL archiving backup job.',
  tags: ['Admin System'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'Backup status returned successfully',
      content: { 'application/json': { schema: schemas.backupStatusResponseSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
    },
    403: {
      description: 'Forbidden - Requires admin role',
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
    },
  },
});

// Reports paths
registry.registerPath({
  method: 'post',
  path: '/api/reports',
  summary: 'Start a report generation job',
  description: 'Queues an asynchronous report generation job for the given report type. Returns job metadata immediately.',
  tags: ['Reports'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: schemas.createReportBodySchema } },
    },
  },
  responses: {
    202: {
      description: 'Report job queued',
      content: {
        'application/json': {
          schema: z.object({ jobId: z.string(), status: z.string(), type: z.string(), createdAt: z.string() }),
        },
      },
    },
    400: {
      description: 'Validation error (invalid or missing report type)',
      content: { 'application/json': { schema: z.object({ error: z.string(), details: z.array(z.any()) }) } },
    },
    429: {
      description: 'Rate limit exceeded (maximum concurrent jobs per org)',
      content: { 'application/json': { schema: z.object({ error: z.string(), code: z.string() }) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/reports/top-talkers',
  summary: 'Top talkers report',
  description: 'Returns the top N tenants by request count in the aggregate window.',
  tags: ['Reports'],
  request: { query: schemas.topTalkersQuerySchema },
  responses: {
    200: {
      description: 'Top talkers data',
      content: { 'application/json': { schema: schemas.topTalkersResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/reports/{jobId}',
  summary: 'Get report job status',
  description: 'Returns the status and artifact URL of a report generation job.',
  tags: ['Reports'],
  request: { params: schemas.reportJobParamsSchema },
  responses: {
    200: {
      description: 'Report job status',
      content: {
        'application/json': {
          schema: z.object({ jobId: z.string(), status: z.string(), type: z.string(), artifactUrl: z.string().optional(), failureReason: z.string().optional(), createdAt: z.string(), updatedAt: z.string() }),
        },
      },
    },
    404: {
      description: 'Report job not found',
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/reports/download/{key}',
  summary: 'Download a report artifact',
  description: 'Serves the report artifact using a signed URL with expires and signature query parameters.',
  tags: ['Reports'],
  request: {
    params: z.object({ key: z.string().min(1) }),
    query: z.object({ expires: z.string().min(1), signature: z.string().min(1) }),
  },
  responses: {
    200: {
      description: 'Report artifact (PDF)',
      content: { 'application/pdf': { schema: z.any() } },
    },
    400: {
      description: 'Missing required query parameters (expires or signature)',
      content: { 'application/json': { schema: z.object({ error: z.string(), code: z.string() }) } },
    },
    401: {
      description: 'Invalid or expired signed URL',
      content: { 'application/json': { schema: z.object({ error: z.string(), code: z.string() }) } },
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
