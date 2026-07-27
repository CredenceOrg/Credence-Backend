import type { Request, Response, NextFunction } from 'express'
import type { ZodSchema } from 'zod'
import { logger } from '../utils/logger.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the response validation middleware should be active.
 * Active in development — inactive in production and test runs
 * to avoid noisy test output.
 */
function shouldValidate(): boolean {
  const env = process.env.NODE_ENV ?? 'development'
  if (env === 'production') return false
  if (env === 'test') return false
  return true
}

/**
 * Log a loud, visually distinct error block when a response shape
 * violates the OpenAPI contract.
 */
function logShapeViolation(
  method: string,
  url: string,
  statusCode: number,
  errorLines: string[],
): void {
  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║  RESPONSE SHAPE VIOLATION — OpenAPI contract mismatch       ║',
    '╠══════════════════════════════════════════════════════════════╣',
    `║  Route:  ${method} ${url}`,
    `║  Status: ${statusCode}`,
    '╠══════════════════════════════════════════════════════════════╣',
    '║  Validation errors:                                         ║',
    ...errorLines.map((l) => `║ ${l.padEnd(60)}║`),
    '╠══════════════════════════════════════════════════════════════╣',
    '║  Fix: update the handler or the Zod schema so they match.   ║',
    '║  Regenerate: npm run generate:openapi                       ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
  ]

  console.error(lines.join('\n'))

  logger.warn({
    route: `${method} ${url}`,
    statusCode,
    errors: errorLines,
    message: 'Response shape violates OpenAPI contract',
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema name mapping: PascalCase OpenAPI $ref → camelCase Zod export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a PascalCase schema name from the OpenAPI spec
 * (e.g. "BondResponse") to the expected Zod export key
 * (e.g. "bondResponseSchema").
 */
function schemaRefToExportKey(refName: string): string {
  return refName.charAt(0).toLowerCase() + refName.slice(1) + 'Schema'
}

/**
 * Converts an OpenAPI path template (e.g. "/api/bond/{address}")
 * to a RegExp that matches Express-style paths.
 */
function openApiPathToRegex(template: string): RegExp {
  // Replace {param} with a capturing group for any non-slash chars
  const pattern = template
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex specials (except {})
    .replace(/\\\{([^}]+)\\\}/g, '([^/]+)') // {param} → capturing group
  return new RegExp(`^${pattern}$`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Global dev-mode response validator
// ─────────────────────────────────────────────────────────────────────────────

interface RouteSchemaEntry {
  regex: RegExp
  method: string
  responses: Map<number, ZodSchema>
}

let routeSchemaCache: RouteSchemaEntry[] | null = null
let routeSchemaCacheLoaded = false

/**
 * Loads and parses `docs/openapi.yaml` to build a route → response schema
 * lookup table. Results are cached after first call.
 *
 * Schema references in the YAML (e.g. `$ref: '#/components/schemas/BondResponse'`)
 * are resolved against the Zod schemas exported from `src/schemas/index.ts`.
 *
 * This function is lazy — it only runs when the dev-mode middleware is first
 * invoked and never in production.
 */
async function loadRouteSchemas(): Promise<RouteSchemaEntry[]> {
  if (routeSchemaCacheLoaded) return routeSchemaCache ?? []

  try {
    // Dynamic imports so production builds never pull in yaml or schema deps
    const YAML = await import('yaml')
    const fs = await import('fs')
    const path = await import('path')
    const schemas = await import('../schemas/index.js')

    const schemaMap = schemas as Record<string, ZodSchema | unknown>

    // Resolve docs/openapi.yaml relative to project root
    const yamlPath = path.resolve(
      // __dirname equivalent for ESM
      new URL('..', import.meta.url).pathname,
      '..',
      '..',
      'docs',
      'openapi.yaml',
    )

    if (!fs.existsSync(yamlPath)) {
      logger.warn({ yamlPath, message: 'OpenAPI spec not found — response validation disabled' })
      routeSchemaCacheLoaded = true
      return []
    }

    const raw = fs.readFileSync(yamlPath, 'utf-8')
    const doc = YAML.parse(raw) as {
      paths?: Record<string, Record<string, {
        responses?: Record<string, {
          content?: { 'application/json'?: { schema?: { $ref?: string } } }
        }>
      }>>
    }

    if (!doc?.paths) {
      routeSchemaCacheLoaded = true
      return []
    }

    const entries: RouteSchemaEntry[] = []

    for (const [openApiPath, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods ?? {})) {
        if (!operation?.responses) continue

        const responses = new Map<number, ZodSchema>()

        for (const [statusStr, response] of Object.entries(operation.responses)) {
          const statusCode = parseInt(statusStr, 10)
          if (isNaN(statusCode)) continue

          const ref = response?.content?.['application/json']?.schema?.$ref
          if (!ref) continue

          // Extract schema name from $ref (e.g. "#/components/schemas/BondResponse" → "BondResponse")
          const refName = ref.split('/').pop()
          if (!refName) continue

          const exportKey = schemaRefToExportKey(refName)
          const zodSchema = schemaMap[exportKey]

          if (zodSchema && typeof (zodSchema as ZodSchema).safeParse === 'function') {
            responses.set(statusCode, zodSchema as ZodSchema)
          }
        }

        if (responses.size > 0) {
          entries.push({
            regex: openApiPathToRegex(openApiPath),
            method: method.toUpperCase(),
            responses,
          })
        }
      }
    }

    // Sort by specificity: fewer parameterized segments first so concrete
    // paths (e.g. /api/items/search) are tried before generic ones
    // (e.g. /api/items/{id}).
    entries.sort((a, b) => {
      const aParams = (a.regex.source.match(/\(\[\^\/\]\+\)/g) || []).length
      const bParams = (b.regex.source.match(/\(\[\^\/\]\+\)/g) || []).length
      return aParams - bParams
    })

    routeSchemaCache = entries
    routeSchemaCacheLoaded = true

    if (entries.length > 0) {
      logger.info({
        routeCount: entries.length,
        message: 'OpenAPI response validation active — will fail loud on shape violations',
      })
    }

    return entries
  } catch (err) {
    logger.warn({ err, message: 'Failed to load OpenAPI spec for response validation' })
    routeSchemaCacheLoaded = true
    return []
  }
}

/**
 * Creates an Express middleware that automatically validates all JSON
 * API responses against the OpenAPI spec **in development only**.
 *
 * On startup, it parses `docs/openapi.yaml` and builds a mapping of
 * routes to their expected response schemas. When a handler emits a
 * response shape that doesn't match the OpenAPI contract, a loud
 * console error is logged. The response is **always** sent — this
 * middleware fails *loud*, not closed.
 *
 * In production, this middleware is a complete no-op.
 *
 * @example
 * ```ts
 * // In app.ts — only in dev mode:
 * const devValidator = await createDevResponseValidator()
 * if (devValidator) {
 *   app.use(devValidator)
 * }
 * ```
 */
export async function createDevResponseValidator(): Promise<
  ((req: Request, res: Response, next: NextFunction) => void) | null
> {
  if (!shouldValidate()) return null

  const entries = await loadRouteSchemas()
  if (entries.length === 0) return null

  return (req: Request, res: Response, next: NextFunction): void => {
    const originalJson = res.json.bind(res) as (body: unknown) => Response

    res.json = function (body: unknown): Response {
      // Match the current request against the route schema table.
      // We use req.path (the matched path without query string) and
      // req.route?.path (the Express path pattern) as fallback.
      const pathToMatch = req.path

      for (const entry of entries) {
        if (entry.method !== req.method.toUpperCase()) continue
        if (!entry.regex.test(pathToMatch)) continue

        // Check if we have a schema for this status code
        const statusCode = res.statusCode || 200
        const schema = entry.responses.get(statusCode)

        if (schema) {
          const result = schema.safeParse(body)
          if (!result.success) {
            const issues =
              (result.error as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues ?? []
            const errorLines = issues.map(
              (e) => `  - ${e.path.length ? e.path.join('.') : '(root)'}: ${e.message}`,
            )
            logShapeViolation(req.method, req.originalUrl, statusCode, errorLines)
          }
        }
        break
      }

      return originalJson(body)
    } as typeof res.json

    next()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-route opt-in middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for the `validateResponse` middleware.
 */
export interface ValidateResponseOptions {
  /**
   * Zod schema describing the expected response body shape.
   * This should match the schema registered in the OpenAPI spec.
   */
  schema: ZodSchema
}

/**
 * Express middleware that validates the response body against a Zod schema
 * **in non-production environments only**.
 *
 * When a route handler emits a response shape that doesn't match the
 * provided schema, a loud console error is logged with the route, expected
 * shape, actual body, and validation errors. The response is **always**
 * sent — this middleware fails *loud*, not closed.
 *
 * In production, this middleware is a complete no-op (pass-through) to avoid
 * any runtime overhead.
 *
 * @example
 * ```ts
 * import { validateResponse } from '../middleware/validateResponse.js'
 * import { bondResponseSchema } from '../schemas/index.js'
 *
 * router.get('/:address',
 *   validate({ params: bondPathParamsSchema }),
 *   validateResponse({ schema: bondResponseSchema }),
 *   handler
 * )
 * ```
 *
 * @param options - Validation options including the expected Zod schema.
 * @returns Express middleware
 */
export function validateResponse(
  options: ValidateResponseOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const { schema } = options

  return (req: Request, res: Response, next: NextFunction): void => {
    // In production, pass through immediately — zero overhead
    if (!shouldValidate()) {
      next()
      return
    }

    const originalJson = res.json.bind(res) as (body: unknown) => Response

    res.json = function (body: unknown): Response {
      const result = schema.safeParse(body)

      if (!result.success) {
        const issues =
          (result.error as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues ?? []
        const errorLines = issues.map(
          (e) => `  - ${e.path.length ? e.path.join('.') : '(root)'}: ${e.message}`,
        )
        logShapeViolation(req.method, req.originalUrl, res.statusCode, errorLines)
      }

      // Always send the response — fail loud, not closed
      return originalJson(body)
    } as typeof res.json

    next()
  }
}

export default validateResponse
