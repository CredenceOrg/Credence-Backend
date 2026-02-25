/**
 * Builds runtime OpenAPI specification from implementation-owned definitions.
 */
export function buildOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Credence API',
      version: '0.1.0',
      description: 'Runtime-generated API specification for Credence backend.',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['error', 'message'],
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
        DisputeSubmissionRequest: {
          type: 'object',
          required: ['slash_request_id', 'identity', 'evidence'],
          properties: {
            slash_request_id: { type: 'string', example: 'slash-123' },
            identity: {
              type: 'string',
              pattern: '^G[A-Z2-7]{55}$',
              example: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
            },
            evidence: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
              example: ['tx:abc123', 'ipfs://QmEvidenceCid'],
            },
            stake: { type: 'string', example: '100.25', nullable: true },
          },
        },
      },
    },
    paths: {
      '/api/health': {
        get: {
          summary: 'Readiness health check',
          responses: {
            '200': {
              description: 'Health status',
            },
          },
        },
      },
      '/api/health/ready': {
        get: {
          summary: 'Readiness alias',
          responses: { '200': { description: 'Ready status' } },
        },
      },
      '/api/health/live': {
        get: {
          summary: 'Liveness check',
          responses: { '200': { description: 'Process is alive' } },
        },
      },
      '/api/trust/{address}': {
        get: {
          summary: 'Get trust score',
          parameters: [
            {
              name: 'address',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
            },
          ],
          responses: { '200': { description: 'Trust score response' } },
        },
      },
      '/api/bond/{address}': {
        get: {
          summary: 'Get bond status',
          parameters: [
            {
              name: 'address',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
            },
          ],
          responses: { '200': { description: 'Bond status response' } },
        },
      },
      '/api/bulk/verify': {
        post: {
          summary: 'Bulk verification',
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['addresses'],
                  properties: {
                    addresses: {
                      type: 'array',
                      minItems: 1,
                      items: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Bulk verification result' },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/governance/disputes': {
        post: {
          summary: 'Submit a dispute against a slash request',
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DisputeSubmissionRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Dispute submitted',
              content: {
                'application/json': {
                  examples: {
                    submitted: {
                      value: {
                        dispute: {
                          id: 'dispute-123',
                          slash_request_id: 'slash-123',
                          identity: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
                          evidence: ['tx:abc123'],
                          stake: '100',
                          status: 'submitted',
                          submitted_at: '2026-02-25T00:00:00.000Z',
                        },
                        arbitration: {
                          event: 'governance.dispute_submitted',
                          queued: true,
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': {
              description: 'Validation error',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Slash request not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'Conflict (not disputable/already disputed)',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '422': {
              description: 'Submission deadline passed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api-docs/openapi.json': {
        get: {
          summary: 'Runtime OpenAPI JSON',
          responses: { '200': { description: 'OpenAPI JSON document' } },
        },
      },
    },
  }
}
