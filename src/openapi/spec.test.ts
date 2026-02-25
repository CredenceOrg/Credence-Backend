import { describe, expect, it } from 'vitest'
import { buildOpenApiSpec } from './spec.js'

describe('buildOpenApiSpec', () => {
  it('includes required API paths', () => {
    const spec = buildOpenApiSpec()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.paths['/api/health']).toBeDefined()
    expect(spec.paths['/api/health/ready']).toBeDefined()
    expect(spec.paths['/api/health/live']).toBeDefined()
    expect(spec.paths['/api/trust/{address}']).toBeDefined()
    expect(spec.paths['/api/bond/{address}']).toBeDefined()
    expect(spec.paths['/api/bulk/verify']).toBeDefined()
    expect(spec.paths['/api/governance/disputes']).toBeDefined()
    expect(spec.paths['/api-docs/openapi.json']).toBeDefined()
  })

  it('documents dispute submission schema and auth', () => {
    const spec = buildOpenApiSpec()
    const operation = spec.paths['/api/governance/disputes'].post
    expect(operation.security).toEqual([{ BearerAuth: [] }])

    const schemaRef =
      operation.requestBody.content['application/json'].schema.$ref
    expect(schemaRef).toBe('#/components/schemas/DisputeSubmissionRequest')
  })
})
